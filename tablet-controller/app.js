const trackViews = new Map();
const connectionState = document.querySelector('.connection-state');
const connectionLabel = document.getElementById('connection-label');
let socket = null;
let reconnectTimer = null;
const jogPhysics = {
  maxSpeed: 16,
  inertiaSeconds: 0.7
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function createCueButtons(trackNum) {
  const grid = document.getElementById(`cue-grid-${trackNum}`);
  for (let index = 0; index < 8; index += 1) {
    const button = document.createElement('button');
    button.className = 'cue-button';
    button.type = 'button';
    button.dataset.number = String(index + 1);
    button.dataset.index = String(index);
    button.innerHTML = '<strong>EMPTY</strong><span>NOT ASSIGNED</span>';
    button.disabled = true;

    const sendCue = pressed => {
      if (button.disabled) return;
      sendMessage({
        type: 'cue',
        trackNum,
        cueIndex: index,
        pressed
      });
      button.classList.toggle('pressed', pressed);
    };

    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      sendCue(true);
    });
    button.addEventListener('pointerup', event => {
      event.preventDefault();
      sendCue(false);
    });
    button.addEventListener('pointercancel', () => sendCue(false));
    button.addEventListener('contextmenu', event => event.preventDefault());
    grid.appendChild(button);
  }
}

function setupTransportButtons(trackNum) {
  const bindings = [
    {
      button: document.getElementById(`transport-play-${trackNum}`),
      action: 'playPause'
    },
    {
      button: document.getElementById(`transport-stop-${trackNum}`),
      action: 'stop'
    }
  ];

  bindings.forEach(({ button, action }) => {
    if (!button) return;
    button.addEventListener('click', () => {
      sendMessage({ type: 'transport', trackNum, action });
    });
    button.addEventListener('pointerdown', () => {
      button.classList.add('pressed');
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
      button.addEventListener(eventName, () => {
        button.classList.remove('pressed');
      });
    });
    button.addEventListener('contextmenu', event => event.preventDefault());
  });
}

function getPointerAngle(event, element) {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  return Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;
}

function normalizeAngleDelta(delta) {
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

function shapeVinylVelocity(rawVelocity) {
  let velocity = rawVelocity;
  if (Math.abs(velocity) >= 1) {
    velocity =
      Math.sign(velocity) *
      (1 + Math.pow(Math.abs(velocity) - 1, 0.78));
  }
  velocity *= jogPhysics.maxSpeed / 16;
  return Math.max(
    -jogPhysics.maxSpeed,
    Math.min(jogPhysics.maxSpeed, velocity)
  );
}

function setupJog(trackNum) {
  const shell = document.getElementById(`jog-${trackNum}`);
  const disc = shell.querySelector('.jog-disc');
  const view = {
    shell,
    disc,
    dragging: false,
    pointerId: null,
    lastAngle: 0,
    mediaTime: 0,
    receivedAt: performance.now(),
    playing: false,
    speed: 1,
    rotation: 0,
    angularVelocity: 0,
    jogVelocity: 0,
    scratching: false,
    coasting: false,
    lastMoveAt: performance.now(),
    coverVersion: -1
  };
  trackViews.set(trackNum, view);

  shell.addEventListener('pointerdown', event => {
    event.preventDefault();
    view.dragging = true;
    view.pointerId = event.pointerId;
    view.lastAngle = getPointerAngle(event, shell);
    view.lastMoveAt = performance.now();
    view.angularVelocity = 0;
    view.jogVelocity = 0;
    view.scratching = true;
    view.coasting = false;
    view.receivedAt = view.lastMoveAt;
    shell.setPointerCapture(event.pointerId);
    shell.classList.add('grabbed');
    shell.classList.remove('coasting');
    sendMessage({ type: 'jogStart', trackNum });
  });

  shell.addEventListener('pointermove', event => {
    if (!view.dragging || event.pointerId !== view.pointerId) return;
    event.preventDefault();
    const nextAngle = getPointerAngle(event, shell);
    const angleDelta = normalizeAngleDelta(nextAngle - view.lastAngle);
    view.lastAngle = nextAngle;
    if (Math.abs(angleDelta) < 0.08) return;

    const now = performance.now();
    const elapsedMs = Math.max(4, Math.min(120, now - view.lastMoveAt));
    view.lastMoveAt = now;
    const targetJogVelocity = shapeVinylVelocity(
      (angleDelta / 120) / (elapsedMs / 1000)
    );
    const changedDirection =
      view.jogVelocity !== 0 &&
      Math.sign(view.jogVelocity) !== Math.sign(targetJogVelocity);
    view.jogVelocity = changedDirection
      ? targetJogVelocity
      : view.jogVelocity * 0.24 + targetJogVelocity * 0.76;
    view.angularVelocity = view.jogVelocity * 120;

    const deltaSeconds = Math.max(-1.5, Math.min(1.5, angleDelta / 120));
    view.mediaTime = Math.max(0, view.mediaTime + deltaSeconds);
    view.receivedAt = now;
    view.rotation += angleDelta;
    disc.style.transform = `rotate(${view.rotation}deg)`;
    sendMessage({ type: 'jogMove', trackNum, deltaSeconds, elapsedMs });
  });

  const releaseJog = event => {
    if (!view.dragging) return;
    if (event && event.pointerId !== view.pointerId) return;
    view.dragging = false;
    view.pointerId = null;
    view.scratching = true;
    view.coasting = true;
    view.receivedAt = performance.now();
    shell.classList.remove('grabbed');
    shell.classList.add('coasting');
    sendMessage({ type: 'jogEnd', trackNum });
  };
  shell.addEventListener('pointerup', releaseJog);
  shell.addEventListener('pointercancel', releaseJog);
  shell.addEventListener('lostpointercapture', releaseJog);
  shell.addEventListener('contextmenu', event => event.preventDefault());
}

function renderTrack(track, index) {
  const trackNum = index + 1;
  const view = trackViews.get(trackNum);
  if (!view) return;

  document.getElementById(`track-title-${trackNum}`).textContent =
    track.title || `TRACK ${trackNum} (EMPTY)`;
  document.getElementById(`track-bpm-${trackNum}`).textContent =
    Number.isFinite(track.bpm) ? Math.round(track.bpm) : '--';

  if (!view.dragging) {
    view.mediaTime = Number(track.mediaTime) || 0;
    view.receivedAt = performance.now();
  }
  view.playing = track.playing === true;
  view.speed = Number(track.speed) || 1;
  view.scratching = track.scratching === true;
  view.coasting = track.coasting === true;
  view.jogVelocity = Number.isFinite(Number(track.jogVelocity))
    ? Number(track.jogVelocity)
    : view.speed;
  view.shell.classList.toggle('coasting', view.coasting && !view.dragging);

  if (view.coverVersion !== track.coverVersion) {
    view.coverVersion = track.coverVersion;
    const cover = document.getElementById(`jog-cover-${trackNum}`);
    cover.src = `/cover/${trackNum}?v=${encodeURIComponent(track.coverVersion || 0)}`;
  }
  view.shell.classList.toggle('no-cover', track.hasCover !== true);
  const playButton = document.getElementById(`transport-play-${trackNum}`);
  if (playButton) {
    playButton.classList.toggle('active', view.playing);
    playButton.textContent = view.playing ? 'PAUSE' : 'PLAY';
  }

  const buttons = document.querySelectorAll(
    `#cue-grid-${trackNum} .cue-button`
  );
  const cues = Array.isArray(track.cues) ? track.cues : [];
  buttons.forEach((button, cueIndex) => {
    const cue = cues[cueIndex] || {};
    const title = button.querySelector('strong');
    const meta = button.querySelector('span');
    const enabled = cue.enabled === true;
    button.disabled = !enabled;
    button.classList.toggle('loaded', enabled);
    title.textContent = cue.label || 'EMPTY';
    meta.textContent = cue.isCue
      ? formatTime(Number(cue.time) || 0)
      : enabled
        ? 'SAMPLE'
        : 'NOT ASSIGNED';
  });
}

function renderState(state) {
  if (!state || !Array.isArray(state.tracks)) return;
  const maxSpeed = Number(state.jogPhysics?.maxSpeed);
  const inertiaSeconds = Number(state.jogPhysics?.inertiaSeconds);
  if (Number.isFinite(maxSpeed)) {
    jogPhysics.maxSpeed = Math.max(2, Math.min(32, maxSpeed));
  }
  if (Number.isFinite(inertiaSeconds)) {
    jogPhysics.inertiaSeconds = Math.max(0, Math.min(5, inertiaSeconds));
  }
  state.tracks.forEach(renderTrack);
}

function sendMessage(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function setConnected(connected) {
  connectionState.classList.toggle('connected', connected);
  connectionLabel.textContent = connected ? 'CONNECTED' : 'RECONNECTING';
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/controller`);
  socket.addEventListener('open', () => {
    setConnected(true);
    sendMessage({ type: 'requestState' });
  });
  socket.addEventListener('message', event => {
    try {
      renderState(JSON.parse(event.data));
    } catch (error) {
      console.warn('Invalid NotoMixer state', error);
    }
  });
  socket.addEventListener('close', () => {
    trackViews.forEach(view => {
      view.dragging = false;
      view.pointerId = null;
      view.scratching = false;
      view.coasting = false;
      view.jogVelocity = 0;
      view.shell.classList.remove('grabbed');
      view.shell.classList.remove('coasting');
    });
    setConnected(false);
    reconnectTimer = setTimeout(connect, 1200);
  });
  socket.addEventListener('error', () => socket.close());
}

function animateJogWheels(now) {
  trackViews.forEach(view => {
    if (!view.dragging) {
      const elapsed = Math.max(0, (now - view.receivedAt) / 1000);
      const playbackVelocity = view.scratching
        ? view.jogVelocity
        : (view.playing ? view.speed : 0);
      const predictedTime =
        view.mediaTime + elapsed * playbackVelocity;
      view.rotation = predictedTime * 120;
      view.disc.style.transform = `rotate(${view.rotation}deg)`;
    }
  });
  requestAnimationFrame(animateJogWheels);
}

[1, 2].forEach(trackNum => {
  createCueButtons(trackNum);
  setupTransportButtons(trackNum);
  setupJog(trackNum);
});
connect();
requestAnimationFrame(animateJogWheels);

window.addEventListener('pagehide', () => {
  trackViews.forEach((view, trackNum) => {
    if (view.dragging) sendMessage({ type: 'jogEnd', trackNum });
  });
});
