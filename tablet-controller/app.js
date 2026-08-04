const trackViews = new Map();
const connectionState = document.querySelector('.connection-state');
const connectionLabel = document.getElementById('connection-label');
let socket = null;
let reconnectTimer = null;
let tabletLibrary = { playlists: [], songs: [] };
let activeSongSelectorTrack = null;
const songSelectorStates = new Map();
const songSelectorClickGuardMs = 500;
const bpmFilterStates = [
  { id: 'ALL', label: 'ALL' },
  { id: 'MATCH', label: '\u2713' },
  { id: 'WARN', label: '\u26A0' },
  { id: 'FAR', label: '\u2715' }
];
const jogPhysics = {
  maxSpeed: 16,
  inertiaSeconds: 0.7
};
const mixerSnap = {
  enabled: false,
  thresholdPct: 5
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function getSongDisplayTitle(title) {
  return String(title || 'UNTITLED').replace(
    /\.(mp3|wav|ogg|aac|flac|m4a)$/i,
    ''
  );
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
    const activePointers = new Set();

    const sendCue = pressed => {
      if (pressed && button.disabled) return;
      sendMessage({
        type: 'cue',
        trackNum,
        cueIndex: index,
        pressed
      });
      button.classList.toggle('pressed', pressed);
    };

    const releaseCuePointer = event => {
      if (!activePointers.delete(event.pointerId)) return;
      if (activePointers.size === 0) sendCue(false);
    };

    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (event.button !== 0) return;
      if (activePointers.has(event.pointerId)) return;
      activePointers.add(event.pointerId);
      try {
        button.setPointerCapture(event.pointerId);
      } catch (error) {}
      if (activePointers.size === 1) sendCue(true);
    });
    button.addEventListener('pointerup', event => {
      event.preventDefault();
      releaseCuePointer(event);
    });
    button.addEventListener('pointercancel', releaseCuePointer);
    button.addEventListener('lostpointercapture', releaseCuePointer);
    button.addEventListener('pointerleave', releaseCuePointer);
    button.addEventListener('contextmenu', event => event.preventDefault());
    grid.appendChild(button);
  }
}

function cancelLocalJog(trackNum) {
  const view = trackViews.get(trackNum);
  if (!view) return;

  const wasDragging = view.dragging;
  const pointerId = view.pointerId;
  view.dragging = false;
  view.pointerId = null;
  view.scratching = false;
  view.coasting = false;
  view.angularVelocity = 0;
  view.jogVelocity = 0;
  view.receivedAt = performance.now();
  view.shell.classList.remove('grabbed', 'coasting');

  if (
    pointerId !== null &&
    typeof view.shell.hasPointerCapture === 'function' &&
    view.shell.hasPointerCapture(pointerId)
  ) {
    try {
      view.shell.releasePointerCapture(pointerId);
    } catch (error) {}
  }
  if (wasDragging) sendMessage({ type: 'jogEnd', trackNum });
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
    const activePointers = new Set();
    let lastPointerActivationAt = Number.NEGATIVE_INFINITY;

    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (event.button !== 0) return;
      if (activePointers.has(event.pointerId)) return;
      activePointers.add(event.pointerId);
      lastPointerActivationAt = performance.now();
      try {
        button.setPointerCapture(event.pointerId);
      } catch (error) {}
      button.classList.add('pressed');
      cancelLocalJog(trackNum);
      sendMessage({ type: 'transport', trackNum, action });
    });

    const releaseTransportPointer = event => {
      if (!activePointers.delete(event.pointerId)) return;
      if (activePointers.size === 0) button.classList.remove('pressed');
    };
    [
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'pointerleave'
    ].forEach(eventName => {
      button.addEventListener(eventName, releaseTransportPointer);
    });
    button.addEventListener('click', event => {
      // Browsers synthesize click after touch/pointer activation. The action
      // was already sent on pointerdown; only accept standalone keyboard clicks.
      if (performance.now() - lastPointerActivationAt < 750) {
        event.preventDefault();
        return;
      }
      cancelLocalJog(trackNum);
      sendMessage({ type: 'transport', trackNum, action });
    });
    button.addEventListener('contextmenu', event => event.preventDefault());
  });
}

function formatMixerControlValue(param, value) {
  const rounded = Math.round(Number(value) || 0);
  if (param === 'filter') {
    if (rounded === 50) return 'BYP';
    return rounded < 50 ? `LP ${Math.abs((rounded - 50) * 2)}` : `HP ${(rounded - 50) * 2}`;
  }
  if (param === 'pan') {
    if (rounded === 0) return 'C';
    return rounded < 0 ? `L ${Math.abs(rounded)}` : `R ${rounded}`;
  }
  return `${rounded}%`;
}

function controllerKnobPoint(angle) {
  const radians = (angle - 90) * Math.PI / 180;
  return {
    x: 20 + 16 * Math.cos(radians),
    y: 20 + 16 * Math.sin(radians)
  };
}

function drawControllerKnobArc(element, percent) {
  if (!element || percent <= 0) {
    if (element) element.setAttribute('d', '');
    return;
  }
  const startAngle = -135;
  const endAngle = startAngle + percent * 270;
  const start = controllerKnobPoint(startAngle);
  const end = controllerKnobPoint(endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  element.setAttribute(
    'd',
    `M ${start.x} ${start.y} A 16 16 0 ${largeArcFlag} 1 ${end.x} ${end.y}`
  );
}

function applyMixerControlSnap(param, value, min, max) {
  if (!mixerSnap.enabled) return value;
  const snapTargets = {
    filter: 50,
    pan: 0,
    speed: 100
  };
  if (!Object.prototype.hasOwnProperty.call(snapTargets, param)) return value;
  const threshold = (mixerSnap.thresholdPct / 100) * (max - min);
  const target = snapTargets[param];
  return Math.abs(value - target) <= threshold ? target : value;
}

function updateLocalMixerControl(trackNum, param, value, { send = false } = {}) {
  const rotary = document.querySelector(
    `.rotary-control[data-track="${trackNum}"][data-param="${param}"]`
  );
  const fader = document.getElementById(`control-${param}-${trackNum}`);
  const min = Number(rotary?.dataset.min ?? fader?.min ?? 0);
  const max = Number(rotary?.dataset.max ?? fader?.max ?? 100);
  const clampedValue = Math.max(min, Math.min(max, Number(value) || 0));
  const snappedValue = send
    ? applyMixerControlSnap(param, clampedValue, min, max)
    : clampedValue;
  const safeValue = Math.round(snappedValue);

  if (rotary) {
    const percent = (safeValue - min) / Math.max(1, max - min);
    rotary.dataset.value = String(safeValue);
    rotary.setAttribute('aria-valuemin', String(min));
    rotary.setAttribute('aria-valuemax', String(max));
    rotary.setAttribute('aria-valuenow', String(safeValue));
    rotary.setAttribute('aria-label', `Track ${trackNum} ${param}`);
    const pointer = rotary.querySelector('.knob-pointer-line');
    const fill = rotary.querySelector('.knob-fill-arc');
    const output = rotary.querySelector('output');
    drawControllerKnobArc(fill, percent);
    if (pointer) {
      pointer.setAttribute('transform', `rotate(${-135 + percent * 270} 20 20)`);
    }
    if (output) output.textContent = formatMixerControlValue(param, safeValue);
  }

  if (fader) fader.value = String(safeValue);
  const faderValue = document.getElementById(`control-${param}-value-${trackNum}`);
  if (faderValue) faderValue.textContent = String(safeValue);

  if (send) sendMessage({ type: 'control', trackNum, param, value: safeValue });
}

function setupRotaryControls(trackNum) {
  document.querySelectorAll(`.rotary-control[data-track="${trackNum}"]`).forEach(control => {
    const param = control.dataset.param;
    let pointerId = null;
    let startY = 0;
    let startValue = Number(control.dataset.value) || 0;

    const release = event => {
      if (pointerId === null || (event && event.pointerId !== pointerId)) return;
      pointerId = null;
      control.classList.remove('grabbed');
    };

    control.addEventListener('pointerdown', event => {
      if (event.button !== 0 || pointerId !== null) return;
      event.preventDefault();
      pointerId = event.pointerId;
      startY = event.clientY;
      startValue = Number(control.dataset.value) || 0;
      control.classList.add('grabbed');
      try {
        control.setPointerCapture(event.pointerId);
      } catch (error) {}
    });
    control.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const min = Number(control.dataset.min);
      const max = Number(control.dataset.max);
      const nextValue = startValue + ((startY - event.clientY) / 110) * (max - min);
      updateLocalMixerControl(trackNum, param, nextValue, { send: true });
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(eventName => {
      control.addEventListener(eventName, release);
    });
    control.addEventListener('dblclick', () => {
      const resetValue = param === 'filter' ? 50 : 0;
      updateLocalMixerControl(trackNum, param, resetValue, { send: true });
    });
    control.addEventListener('keydown', event => {
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? -1
          : 0;
      if (!direction) return;
      event.preventDefault();
      updateLocalMixerControl(
        trackNum,
        param,
        (Number(control.dataset.value) || 0) + direction,
        { send: true }
      );
    });
    control.addEventListener('contextmenu', event => event.preventDefault());
    updateLocalMixerControl(trackNum, param, startValue);
  });
}

function setupFaderControls(trackNum) {
  ['speed', 'volume'].forEach(param => {
    const input = document.getElementById(`control-${param}-${trackNum}`);
    if (!input) return;
    input.addEventListener('input', () => {
      updateLocalMixerControl(trackNum, param, Number(input.value), { send: true });
    });
    updateLocalMixerControl(trackNum, param, Number(input.value));
  });
}

function setupLoopControls(trackNum) {
  const panel = document.querySelector(`.loop-panel[data-track="${trackNum}"]`);
  if (!panel) return;
  panel.querySelectorAll('[data-loop-action]').forEach(button => {
    button.addEventListener('click', () => {
      sendMessage({ type: 'loop', trackNum, action: button.dataset.loopAction });
    });
  });
}

function renderMixerControls(trackNum, track) {
  const controls = track?.controls || {};
  ['filter', 'echo', 'reverb', 'pan', 'speed', 'volume'].forEach(param => {
    if (Number.isFinite(Number(controls[param]))) {
      updateLocalMixerControl(trackNum, param, Number(controls[param]));
    }
  });

  const loop = track?.loop || {};
  const loopValue = document.getElementById(`loop-value-${trackNum}`);
  if (loopValue && loop.beats !== undefined) loopValue.textContent = String(loop.beats);
  const panel = document.querySelector(`.loop-panel[data-track="${trackNum}"]`);
  if (!panel) return;
  panel.querySelector('[data-loop-action="auto"]')?.classList.toggle('active', loop.enabled === true);
  panel.querySelector('[data-loop-action="in"]')?.classList.toggle('active', loop.hasIn === true);
  panel.querySelector('[data-loop-action="out"]')?.classList.toggle('active', loop.hasOut === true);
}

function getSongBpmCompatibility(songBpm, referenceBpm) {
  if (!Number.isFinite(songBpm) || !Number.isFinite(referenceBpm)) {
    return 'UNKNOWN';
  }
  const difference = Math.abs(songBpm - referenceBpm);
  if (difference <= 5) return 'MATCH';
  if (difference <= 20) return 'WARN';
  return 'FAR';
}

function getBpmCompatibilityLabel(compatibility) {
  if (compatibility === 'MATCH') return '\u2713';
  if (compatibility === 'WARN') return '\u26A0';
  if (compatibility === 'FAR') return '\u2715';
  return '\u00B7';
}

function updateSongSelectorFilters(trackNum) {
  const state = songSelectorStates.get(trackNum);
  const bpmButton = document.getElementById(`song-selector-bpm-filter-${trackNum}`);
  const statusButton = document.getElementById(`song-selector-status-filter-${trackNum}`);
  if (!state || !bpmButton || !statusButton) return;
  const filter = bpmFilterStates.find(item => item.id === state.bpmFilter) || bpmFilterStates[0];
  const bpmTrackValue = bpmButton.querySelector('strong');
  if (bpmTrackValue) bpmTrackValue.textContent = String(state.bpmTrack);
  bpmButton.dataset.track = String(state.bpmTrack);
  bpmButton.title = `Use Track ${state.bpmTrack} as the BPM reference`;
  statusButton.textContent = filter.label;
  statusButton.dataset.status = filter.id;
  statusButton.title = `Sort by BPM compatibility with Track ${state.bpmTrack}`;
}

function toggleSongSelectorBpmTrack(trackNum) {
  const state = songSelectorStates.get(trackNum);
  if (!state) return;
  state.bpmTrack = state.bpmTrack === 1 ? 2 : 1;
  updateSongSelectorFilters(trackNum);
  renderSongSelector(trackNum);
}

function cycleSongSelectorStatusFilter(trackNum) {
  const state = songSelectorStates.get(trackNum);
  if (!state) return;
  const currentIndex = bpmFilterStates.findIndex(item => item.id === state.bpmFilter);
  state.bpmFilter = bpmFilterStates[(currentIndex + 1) % bpmFilterStates.length].id;
  updateSongSelectorFilters(trackNum);
  renderSongSelector(trackNum);
}

function createSongSelectorMetric(label, value, className) {
  const metric = document.createElement('span');
  metric.className = `song-selector-metric ${className}`;
  const metricLabel = document.createElement('span');
  metricLabel.className = 'song-selector-metric-label';
  metricLabel.textContent = label;
  const metricValue = document.createElement('span');
  metricValue.className = 'song-selector-metric-value';
  metricValue.textContent = value;
  metric.appendChild(metricLabel);
  metric.appendChild(metricValue);
  return { metric, metricValue };
}

function renderSongSelector(trackNum) {
  const selector = document.getElementById(`song-selector-${trackNum}`);
  const list = document.getElementById(`song-selector-list-${trackNum}`);
  const search = document.getElementById(`song-selector-search-${trackNum}`);
  const playlist = document.getElementById(`song-selector-playlist-${trackNum}`);
  if (!selector || !list || !search || !playlist) return;

  const state = songSelectorStates.get(trackNum);
  const referenceBpm = trackViews.get(state?.bpmTrack || 1)?.bpm;
  const selectedPlaylist = playlist.value;
  const query = search.value.trim().toLowerCase();
  const filteredSongs = tabletLibrary.songs
    .map(song => ({
      song,
      compatibility: getSongBpmCompatibility(song.bpm, referenceBpm)
    }))
    .filter(({ song }) => {
      const matchesPlaylist = !selectedPlaylist || song.playlist === selectedPlaylist;
      const haystack = `${song.title || ''} ${song.playlist || ''} ${song.key || ''}`.toLowerCase();
      return matchesPlaylist && haystack.includes(query);
    });

  if (state?.bpmFilter && state.bpmFilter !== 'ALL') {
    filteredSongs.sort((left, right) => (
      Number(right.compatibility === state.bpmFilter)
      - Number(left.compatibility === state.bpmFilter)
    ));
  }

  updateSongSelectorFilters(trackNum);

  list.replaceChildren();
  if (filteredSongs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'song-selector-empty';
    empty.textContent = tabletLibrary.songs.length === 0
      ? 'NO SONGS AVAILABLE'
      : 'NO MATCHING SONGS';
    list.appendChild(empty);
    return;
  }

  filteredSongs.forEach(({ song, compatibility }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'song-selector-item';

    const artwork = document.createElement('span');
    artwork.className = 'song-selector-artwork';
    artwork.classList.toggle('no-cover', song.hasCover !== true);
    const artworkImage = document.createElement('img');
    artworkImage.alt = '';
    artworkImage.loading = 'lazy';
    artworkImage.decoding = 'async';
    artworkImage.src = `/library-cover?id=${encodeURIComponent(song.id)}`;
    artwork.appendChild(artworkImage);

    const content = document.createElement('div');
    content.className = 'song-selector-item-content';
    const title = document.createElement('strong');
    title.textContent = getSongDisplayTitle(song.title);
    const folder = document.createElement('span');
    folder.className = 'song-selector-folder';
    folder.textContent = song.playlist || 'ROOT';

    const metrics = document.createElement('div');
    metrics.className = 'song-selector-metrics';
    const keyMetric = createSongSelectorMetric('KEY', song.key || '--', 'key');
    const bpmMetric = createSongSelectorMetric(
      'BPM',
      Number.isFinite(song.bpm) ? String(Math.round(song.bpm)) : '--',
      'bpm'
    );
    const durationMetric = createSongSelectorMetric(
      'DURATION',
      Number.isFinite(song.duration) ? formatTime(song.duration) : '--:--',
      'duration'
    );
    const compatIcon = document.createElement('span');
    compatIcon.className = `song-selector-compat ${compatibility.toLowerCase()}`;
    compatIcon.textContent = getBpmCompatibilityLabel(compatibility);
    bpmMetric.metricValue.appendChild(compatIcon);
    metrics.appendChild(keyMetric.metric);
    metrics.appendChild(bpmMetric.metric);
    metrics.appendChild(durationMetric.metric);
    content.appendChild(title);
    content.appendChild(folder);
    button.appendChild(artwork);
    button.appendChild(content);
    button.appendChild(metrics);
    button.addEventListener('click', () => {
      sendMessage({ type: 'loadSong', trackNum, songId: song.id });
      closeSongSelector(trackNum);
    });
    list.appendChild(button);
  });
}

function updateSongSelectorPlaylists(trackNum) {
  const playlist = document.getElementById(`song-selector-playlist-${trackNum}`);
  if (!playlist) return;
  const previousValue = playlist.value;
  playlist.replaceChildren();

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'SHOW ALL';
  playlist.appendChild(allOption);
  tabletLibrary.playlists.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    playlist.appendChild(option);
  });
  playlist.value = tabletLibrary.playlists.includes(previousValue)
    ? previousValue
    : '';
}

function closeSongSelector(trackNum = activeSongSelectorTrack) {
  if (trackNum !== 1 && trackNum !== 2) return;
  const selector = document.getElementById(`song-selector-${trackNum}`);
  const state = songSelectorStates.get(trackNum);
  if (state) clearTimeout(state.openingTimer);
  if (selector) {
    if (selector.contains(document.activeElement)) document.activeElement.blur();
    selector.hidden = true;
    selector.classList.remove('opening');
  }
  if (activeSongSelectorTrack === trackNum) activeSongSelectorTrack = null;
}

function openSongSelector(trackNum) {
  [1, 2].forEach(candidate => {
    if (candidate !== trackNum) closeSongSelector(candidate);
  });
  const selector = document.getElementById(`song-selector-${trackNum}`);
  const search = document.getElementById(`song-selector-search-${trackNum}`);
  if (!selector) return;
  const state = songSelectorStates.get(trackNum);
  activeSongSelectorTrack = trackNum;
  selector.hidden = false;
  selector.classList.add('opening');
  if (state) {
    state.openedAt = performance.now();
    clearTimeout(state.openingTimer);
    state.openingTimer = setTimeout(() => {
      selector.classList.remove('opening');
    }, songSelectorClickGuardMs);
  }
  if (search) search.value = '';
  updateSongSelectorPlaylists(trackNum);
  renderSongSelector(trackNum);
  sendMessage({ type: 'requestLibrary' });
}

function createSongSelector(trackNum) {
  const deck = document.querySelector(`.deck[data-track="${trackNum}"]`);
  if (!deck) return;
  songSelectorStates.set(trackNum, {
    bpmFilter: 'ALL',
    bpmTrack: 1,
    openedAt: 0,
    openingTimer: null
  });
  const selector = document.createElement('div');
  selector.id = `song-selector-${trackNum}`;
  selector.className = 'song-selector';
  selector.hidden = true;
  selector.innerHTML = `
    <header class="song-selector-header">
      <div class="song-selector-heading"><span>TRACK ${trackNum}</span><strong>AVAILABLE SONGS</strong></div>
      <div class="song-selector-header-actions">
        <div class="song-selector-current-bpm">
          <span>BPM</span><strong id="song-selector-current-bpm-${trackNum}">--</strong>
        </div>
        <button type="button" class="song-selector-close" aria-label="Close song selector">CLOSE</button>
      </div>
    </header>
    <div class="song-selector-controls">
      <input id="song-selector-search-${trackNum}" type="search" placeholder="SEARCH SONGS..." autocomplete="off">
      <select id="song-selector-playlist-${trackNum}" aria-label="Playlist"><option value="">SHOW ALL</option></select>
      <button id="song-selector-status-filter-${trackNum}" class="song-selector-status-filter" type="button" data-status="ALL" aria-label="Sort by BPM compatibility">ALL</button>
      <button id="song-selector-bpm-filter-${trackNum}" class="song-selector-bpm-filter" type="button" data-track="1">
        <span>FILTER BPM</span><strong>1</strong>
      </button>
    </div>
    <div class="song-selector-list" id="song-selector-list-${trackNum}"></div>
  `;
  deck.appendChild(selector);

  selector.addEventListener('click', event => {
    const state = songSelectorStates.get(trackNum);
    if (
      event.target.closest('.song-selector-item')
      && state
      && performance.now() - state.openedAt < songSelectorClickGuardMs
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  selector.querySelector('.song-selector-close').addEventListener('click', () => {
    closeSongSelector(trackNum);
  });
  selector.querySelector(`#song-selector-search-${trackNum}`).addEventListener('input', () => {
    renderSongSelector(trackNum);
  });
  selector.querySelector(`#song-selector-playlist-${trackNum}`).addEventListener('change', () => {
    renderSongSelector(trackNum);
  });
  selector.querySelector(`#song-selector-bpm-filter-${trackNum}`).addEventListener('click', () => {
    toggleSongSelectorBpmTrack(trackNum);
  });
  selector.querySelector(`#song-selector-status-filter-${trackNum}`).addEventListener('click', () => {
    cycleSongSelectorStatusFilter(trackNum);
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
    loading: false,
    bpm: null,
    speed: 1,
    rotation: 0,
    angularVelocity: 0,
    jogVelocity: 0,
    scratching: false,
    coasting: false,
    lastMoveAt: performance.now(),
    coverVersion: -1,
    pointerStartedAt: 0,
    pointerStartX: 0,
    pointerStartY: 0,
    maxPointerTravel: 0,
    lastTapAt: 0
  };
  trackViews.set(trackNum, view);

  shell.addEventListener('pointerdown', event => {
    event.preventDefault();
    view.dragging = true;
    view.pointerId = event.pointerId;
    view.lastAngle = getPointerAngle(event, shell);
    view.lastMoveAt = performance.now();
    view.pointerStartedAt = view.lastMoveAt;
    view.pointerStartX = event.clientX;
    view.pointerStartY = event.clientY;
    view.maxPointerTravel = 0;
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
    view.maxPointerTravel = Math.max(
      view.maxPointerTravel,
      Math.hypot(
        event.clientX - view.pointerStartX,
        event.clientY - view.pointerStartY
      )
    );
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

  const releaseJog = (event, allowTap = false) => {
    if (!view.dragging) return;
    if (event && event.pointerId !== view.pointerId) return;
    const releasedAt = performance.now();
    const wasTap = allowTap
      && releasedAt - view.pointerStartedAt <= 280
      && view.maxPointerTravel <= 12;
    view.dragging = false;
    view.pointerId = null;
    view.scratching = true;
    view.coasting = true;
    view.receivedAt = performance.now();
    shell.classList.remove('grabbed');
    shell.classList.add('coasting');
    sendMessage({ type: 'jogEnd', trackNum });

    if (wasTap) {
      if (releasedAt - view.lastTapAt <= 340) {
        view.lastTapAt = 0;
        openSongSelector(trackNum);
      } else {
        view.lastTapAt = releasedAt;
      }
    } else {
      view.lastTapAt = 0;
    }
  };
  shell.addEventListener('pointerup', event => releaseJog(event, true));
  shell.addEventListener('pointercancel', event => releaseJog(event, false));
  shell.addEventListener('lostpointercapture', event => releaseJog(event, false));
  shell.addEventListener('contextmenu', event => event.preventDefault());
}

function renderTrack(track, index) {
  const trackNum = index + 1;
  const view = trackViews.get(trackNum);
  if (!view) return;

  document.getElementById(`track-title-${trackNum}`).textContent =
    track.title || `TRACK ${trackNum} (EMPTY)`;
  const previousBpm = view.bpm;
  view.bpm = Number.isFinite(track.bpm) ? track.bpm : null;
  document.getElementById(`track-bpm-${trackNum}`).textContent =
    Number.isFinite(view.bpm) ? Math.round(view.bpm) : '--';
  const selectorBpm = document.getElementById(`song-selector-current-bpm-${trackNum}`);
  if (selectorBpm) {
    selectorBpm.textContent = Number.isFinite(view.bpm) ? Math.round(view.bpm) : '--';
  }

  if (!view.dragging) {
    view.mediaTime = Number(track.mediaTime) || 0;
    view.receivedAt = performance.now();
  }
  view.playing = track.playing === true;
  view.loading = track.loading === true;
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
    playButton.classList.toggle('active', view.playing || view.loading);
    playButton.textContent = view.loading ? 'LOADING' : view.playing ? 'PAUSE' : 'PLAY';
  }
  renderMixerControls(trackNum, track);

  if (
    (activeSongSelectorTrack === 1 || activeSongSelectorTrack === 2)
    && songSelectorStates.get(activeSongSelectorTrack)?.bpmTrack === trackNum
    && Number.isFinite(view.bpm)
    && (!Number.isFinite(previousBpm) || Math.abs(previousBpm - view.bpm) >= 0.5)
  ) {
    renderSongSelector(trackNum);
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

function renderLibraryAnalysis(analysis) {
  const overlay = document.getElementById('analysis-lock');
  const progress = document.getElementById('analysis-lock-progress');
  const fill = document.getElementById('analysis-lock-progress-fill');
  const count = document.getElementById('analysis-lock-count');
  const percent = document.getElementById('analysis-lock-percent');
  const current = document.getElementById('analysis-lock-current');
  if (!overlay || !progress || !fill || !count || !percent || !current) return;

  const inProgress = analysis?.inProgress === true;
  const blocking = inProgress && analysis?.blocking === true;
  const wasVisible = !overlay.hidden;
  overlay.hidden = !blocking;
  overlay.setAttribute('aria-hidden', blocking ? 'false' : 'true');
  if (!blocking) return;

  if (!wasVisible) {
    closeSongSelector();
    trackViews.forEach((view, trackNum) => {
      if (view.dragging) sendMessage({ type: 'jogEnd', trackNum });
      view.dragging = false;
      view.pointerId = null;
      view.scratching = false;
      view.coasting = false;
      view.jogVelocity = 0;
      view.shell.classList.remove('grabbed', 'coasting');
    });
  }

  const total = Math.max(0, Number(analysis?.total) || 0);
  const completed = Math.max(0, Math.min(total, Number(analysis?.completed) || 0));
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  progress.setAttribute('aria-valuenow', String(percentage));
  fill.style.width = `${percentage}%`;
  count.textContent = `${completed} / ${total}`;
  percent.textContent = `${percentage}%`;
  current.textContent = String(analysis?.current || '').trim()
    || (total > 0 ? `${total} ${total === 1 ? 'song' : 'songs'} queued` : 'Preparing music library');
}

function renderState(state) {
  if (!state || !Array.isArray(state.tracks)) return;
  renderLibraryAnalysis(state.libraryAnalysis);
  const maxSpeed = Number(state.jogPhysics?.maxSpeed);
  const inertiaSeconds = Number(state.jogPhysics?.inertiaSeconds);
  if (Number.isFinite(maxSpeed)) {
    jogPhysics.maxSpeed = Math.max(2, Math.min(32, maxSpeed));
  }
  if (Number.isFinite(inertiaSeconds)) {
    jogPhysics.inertiaSeconds = Math.max(0, Math.min(5, inertiaSeconds));
  }
  mixerSnap.enabled = state.snap?.enabled === true;
  const snapThresholdPct = Number(state.snap?.thresholdPct);
  if (Number.isFinite(snapThresholdPct)) {
    mixerSnap.thresholdPct = Math.max(1, Math.min(15, snapThresholdPct));
  }
  state.tracks.forEach(renderTrack);
}

function receiveTabletLibrary(library) {
  tabletLibrary = {
    playlists: Array.isArray(library?.playlists) ? library.playlists : [],
    songs: Array.isArray(library?.songs) ? library.songs : []
  };
  if (activeSongSelectorTrack === 1 || activeSongSelectorTrack === 2) {
    updateSongSelectorPlaylists(activeSongSelectorTrack);
    renderSongSelector(activeSongSelectorTrack);
  }
}

function sendMessage(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function setConnected(connected) {
  connectionState.classList.toggle('connected', connected);
  connectionLabel.textContent = connected ? 'CONNECTED' : 'RECONNECTING';
}

function receiveControllerSession(payload) {
  const sessionId = typeof payload?.sessionId === 'string'
    ? payload.sessionId
    : '';
  if (!sessionId) return;
  try {
    const storageKey = 'notoMixer_controllerSessionId';
    const previousSessionId = sessionStorage.getItem(storageKey);
    sessionStorage.setItem(storageKey, sessionId);
    if (previousSessionId && previousSessionId !== sessionId) {
      location.reload();
    }
  } catch (error) {
    console.warn('Unable to track the NotoMixer controller session', error);
  }
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
      const payload = JSON.parse(event.data);
      if (payload?.type === 'session') {
        receiveControllerSession(payload);
      } else if (payload?.type === 'library') {
        receiveTabletLibrary(payload);
      } else {
        renderState(payload);
      }
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
  setupRotaryControls(trackNum);
  setupFaderControls(trackNum);
  setupLoopControls(trackNum);
  createSongSelector(trackNum);
  setupJog(trackNum);
});
connect();
requestAnimationFrame(animateJogWheels);

window.addEventListener('pagehide', () => {
  trackViews.forEach((view, trackNum) => {
    if (view.dragging) sendMessage({ type: 'jogEnd', trackNum });
  });
});
