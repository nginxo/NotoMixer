const { ipcRenderer, webUtils } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');
const { loadNotoMixerConfig } = require('./notomixer-config');
const {
  getCompatibleAudioPath,
  getCompatibleAudioPaths,
  isM4aFile
} = require('./audio-compat');
const {
  hydrateUserSettings,
  saveUserSettings
} = require('./user-settings');
const { version: packageVersion } = require('./package.json');

const notoMixerRoot = process.env.NOTOMIXER_INSTALL_ROOT
  ? path.resolve(process.env.NOTOMIXER_INSTALL_ROOT)
  : process.defaultApp
    ? __dirname
    : path.resolve(process.resourcesPath, '..', '..');
const notoMixerAssetsRoot = path.join(notoMixerRoot, 'assets');
const getNotoMixerAssetUrl = (...segments) =>
  pathToFileURL(path.join(notoMixerAssetsRoot, ...segments)).href;

function getDroppedFilePath(file) {
  if (!file) return '';
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) return filePath;
    }
  } catch (error) {
    console.warn('Unable to resolve dropped file through Electron webUtils.', error);
  }
  return typeof file.path === 'string' ? file.path : '';
}

const headerLogo = document.querySelector('.header-logo-mark');
if (headerLogo) {
  headerLogo.src = getNotoMixerAssetUrl('logo.svg');
}

const notoMixerConfig = loadNotoMixerConfig(notoMixerRoot, packageVersion);
const loadedUserSettingCount = hydrateUserSettings(notoMixerRoot, localStorage);

function persistUserSettings() {
  try {
    return saveUserSettings(notoMixerRoot, localStorage);
  } catch (error) {
    console.warn('Unable to save userSettings.notomixer.', error);
    return '';
  }
}

if (loadedUserSettingCount === 0) {
  persistUserSettings();
}

document.documentElement.classList.toggle(
  'legacy-mode',
  notoMixerConfig.legacyMode
);
document.documentElement.classList.toggle(
  'exclusive-mode',
  notoMixerConfig.exclusiveMode
);
document.documentElement.classList.toggle(
  'hide-audio-levels',
  !notoMixerConfig.showAudioLevel
);
document.documentElement.classList.toggle(
  'spectrum-disabled',
  !notoMixerConfig.enableSpectrum
);
document.documentElement.dataset.notomixerVersion = notoMixerConfig.version;

let initialMixerCheckComplete = false;
let initialSongCheckComplete = false;
let evaluationNoticeShown = false;

function maybeShowEvaluationNotice() {
  if (
    !notoMixerConfig.evaluation ||
    evaluationNoticeShown ||
    !initialMixerCheckComplete ||
    !initialSongCheckComplete ||
    document.body?.classList.contains('app-daemon-locked') ||
    document.getElementById('connection-modal')?.classList.contains('show')
  ) {
    return;
  }

  const modal = document.getElementById('evaluation-modal');
  if (!modal) return;
  evaluationNoticeShown = true;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
}

function hideEvaluationNotice() {
  const modal = document.getElementById('evaluation-modal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

const LEGACY_DEFERRED_UPDATE_VERSION_KEY = 'notoMixer_deferredUpdateVersion';
let availableAppUpdate = null;
let appUpdatePhase = 'idle';
let appUpdateDownloadError = '';
let appUpdateProgress = { receivedBytes: 0, totalBytes: 0, percent: 0 };
let settingsUpdateAcknowledged = false;
let deferredAppUpdateVersion = '';
let appUpdateNotificationAudio = null;
let lastUpdateSoundVersion = '';

// Older builds persisted "Not now" indefinitely. Deferral now lasts only for
// the current app session, so a later launch can present the update again.
localStorage.removeItem(LEGACY_DEFERRED_UPDATE_VERSION_KEY);

function playAppUpdateNotification(version) {
  if (!version || lastUpdateSoundVersion === version) return;
  lastUpdateSoundVersion = version;
  try {
    appUpdateNotificationAudio = new Audio(
      getNotoMixerAssetUrl('audio', 'update.mp3')
    );
    appUpdateNotificationAudio.addEventListener('ended', () => {
      appUpdateNotificationAudio = null;
    }, { once: true });
    appUpdateNotificationAudio.play().catch(() => {});
  } catch (error) {}
}

function formatUpdateBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCurrentUpdateDeferred() {
  return Boolean(
    availableAppUpdate?.version
    && deferredAppUpdateVersion === availableAppUpdate.version
  );
}

function renderAppUpdateBadges() {
  const deferred = isCurrentUpdateDeferred();
  const settingsBadge = document.getElementById('settings-update-badge');
  const infoBadge = document.getElementById('settings-info-update-badge');
  if (settingsBadge) {
    settingsBadge.hidden = !deferred || settingsUpdateAcknowledged;
  }
  if (infoBadge) infoBadge.hidden = !deferred;
}

function renderAppUpdateProgress() {
  const percent = Number.isFinite(Number(appUpdateProgress.percent))
    ? Math.max(0, Math.min(100, Number(appUpdateProgress.percent)))
    : 0;
  const received = formatUpdateBytes(appUpdateProgress.receivedBytes);
  const total = formatUpdateBytes(appUpdateProgress.totalBytes);
  const progressText = total
    ? `${percent}% · ${received} / ${total}`
    : received
      ? `Downloaded ${received}`
      : 'Preparing download…';

  ['modal', 'info'].forEach(location => {
    const progress = document.getElementById(`app-update-${location}-progress`);
    const fill = document.getElementById(`app-update-${location}-progress-fill`);
    const text = document.getElementById(`app-update-${location}-progress-text`);
    if (progress) progress.hidden = appUpdatePhase !== 'downloading';
    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = progressText;
  });
}

function renderAppUpdateInfo() {
  const state = document.getElementById('app-update-info-state');
  const message = document.getElementById('app-update-info-message');
  const detail = document.getElementById('app-update-info-detail');
  const actionButton = document.getElementById('app-update-btn-action');
  if (!state || !message || !detail || !actionButton) return;

  state.className = 'app-update-info-state';
  actionButton.hidden = true;
  actionButton.disabled = false;
  const currentVersion = availableAppUpdate?.currentVersion
    || notoMixerConfig.version;
  detail.textContent = `Current version: v${currentVersion}`;

  if (appUpdatePhase === 'checking') {
    state.textContent = 'CHECKING';
    message.textContent = 'Checking for updates…';
  } else if (appUpdatePhase === 'current') {
    state.textContent = 'UP TO DATE';
    message.textContent = 'You are using the latest published version.';
  } else if (appUpdatePhase === 'no-release') {
    state.textContent = 'NO RELEASE';
    message.textContent = 'No published NotoMixer release is available yet.';
  } else if (appUpdatePhase === 'disabled') {
    state.textContent = 'DISABLED';
    message.textContent = 'Automatic update checks are disabled in config.notomixer.';
  } else if (appUpdatePhase === 'error') {
    state.textContent = 'UNAVAILABLE';
    state.classList.add('error');
    message.textContent = appUpdateDownloadError
      || 'The update check could not be completed.';
  } else if (appUpdatePhase === 'downloading') {
    state.textContent = 'DOWNLOADING';
    state.classList.add('available');
    message.textContent = `Downloading NotoMixer v${availableAppUpdate.version}…`;
    detail.textContent = availableAppUpdate.asset
      ? `${availableAppUpdate.asset.name} · ${formatUpdateBytes(availableAppUpdate.asset.size)}`
      : detail.textContent;
  } else if (appUpdatePhase === 'downloaded') {
    state.textContent = 'READY';
    state.classList.add('downloaded');
    message.textContent = `NotoMixer v${availableAppUpdate.version} is ready to install.`;
    actionButton.hidden = false;
    actionButton.textContent = 'INSTALL UPDATE';
  } else if (availableAppUpdate) {
    state.textContent = availableAppUpdate.prerelease
      ? 'PRERELEASE'
      : 'AVAILABLE';
    state.classList.add('available');
    message.textContent = appUpdateDownloadError
      || `NotoMixer v${availableAppUpdate.version} is available.`;
    detail.textContent = availableAppUpdate.asset
      ? `${availableAppUpdate.asset.name} · ${formatUpdateBytes(availableAppUpdate.asset.size)}`
      : 'This release does not include a Windows installer.';
    actionButton.hidden = false;
    actionButton.disabled = !availableAppUpdate.downloadAvailable;
    actionButton.textContent = appUpdateDownloadError
      ? 'RETRY DOWNLOAD'
      : 'DOWNLOAD UPDATE';
  } else {
    state.textContent = 'AUTOMATIC';
    message.textContent = 'Updates are checked automatically after startup.';
  }

  renderAppUpdateProgress();
  renderAppUpdateBadges();
}

function renderAppUpdateModal() {
  if (!availableAppUpdate) return;
  const title = document.getElementById('app-update-modal-title');
  const current = document.getElementById('app-update-current-version');
  const latest = document.getElementById('app-update-latest-version');
  const detail = document.getElementById('app-update-modal-detail');
  const laterButton = document.getElementById('app-update-btn-later');
  const actionButton = document.getElementById('app-update-btn-download');
  if (title) {
    title.textContent = availableAppUpdate.prerelease
      ? 'PRERELEASE UPDATE AVAILABLE'
      : 'UPDATE AVAILABLE';
  }
  if (current) current.textContent = `v${availableAppUpdate.currentVersion}`;
  if (latest) latest.textContent = `v${availableAppUpdate.version}`;
  if (detail) {
    detail.textContent = appUpdateDownloadError
      || (availableAppUpdate.downloadAvailable
        ? `${availableAppUpdate.prerelease ? 'This is a prerelease. ' : ''}Download the installer directly without leaving the app.`
        : 'The release exists, but it does not include a Windows installer.');
  }
  if (laterButton) {
    laterButton.disabled = appUpdatePhase === 'downloading';
    laterButton.textContent = appUpdatePhase === 'downloaded' ? 'LATER' : 'NOT NOW';
  }
  if (actionButton) {
    actionButton.disabled = appUpdatePhase === 'downloading'
      || (!availableAppUpdate.downloadAvailable && appUpdatePhase !== 'downloaded');
    actionButton.textContent = appUpdatePhase === 'downloaded'
      ? 'INSTALL UPDATE'
      : appUpdatePhase === 'downloading'
        ? 'DOWNLOADING…'
        : appUpdateDownloadError
          ? 'RETRY DOWNLOAD'
          : 'DOWNLOAD UPDATE';
  }
  renderAppUpdateProgress();
}

function showAppUpdateModal() {
  if (!availableAppUpdate) return;
  renderAppUpdateModal();
  const modal = document.getElementById('app-update-modal');
  if (modal) {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function hideAppUpdateModal() {
  const modal = document.getElementById('app-update-modal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
}

function deferAppUpdate() {
  if (!availableAppUpdate?.version || appUpdatePhase === 'downloading') return;
  deferredAppUpdateVersion = availableAppUpdate.version;
  settingsUpdateAcknowledged = false;
  hideAppUpdateModal();
  renderAppUpdateInfo();
}

function handleAvailableAppUpdate(release, { showPrompt = true } = {}) {
  if (!release?.version) return;
  const isNewlyDetectedVersion = availableAppUpdate?.version !== release.version;
  availableAppUpdate = release;
  appUpdatePhase = 'available';
  appUpdateDownloadError = '';
  appUpdateProgress = { receivedBytes: 0, totalBytes: release.asset?.size || 0, percent: 0 };
  renderAppUpdateInfo();
  if (isNewlyDetectedVersion) playAppUpdateNotification(release.version);
  if (showPrompt && !isCurrentUpdateDeferred()) showAppUpdateModal();
}

async function checkForAppUpdatesManually() {
  if (appUpdatePhase === 'downloading') return;
  appUpdatePhase = 'checking';
  appUpdateDownloadError = '';
  renderAppUpdateInfo();
  try {
    const result = await ipcRenderer.invoke('app-update:check');
    if (result?.status === 'available') {
      handleAvailableAppUpdate(result.release, { showPrompt: false });
      return;
    }
    availableAppUpdate = null;
    deferredAppUpdateVersion = '';
    settingsUpdateAcknowledged = true;
    appUpdatePhase = result?.status === 'no-release'
      ? 'no-release'
      : result?.status === 'disabled'
        ? 'disabled'
        : 'current';
  } catch (error) {
    appUpdatePhase = 'error';
    appUpdateDownloadError = 'The update check could not be completed.';
  }
  renderAppUpdateInfo();
}

async function installDownloadedAppUpdate() {
  const modalButton = document.getElementById('app-update-btn-download');
  const infoButton = document.getElementById('app-update-btn-action');
  if (modalButton) modalButton.disabled = true;
  if (infoButton) infoButton.disabled = true;
  try {
    const result = await ipcRenderer.invoke('app-update:install');
    if (!result?.ok) {
      appUpdateDownloadError = result?.error || 'The installer could not be started.';
      renderAppUpdateInfo();
      renderAppUpdateModal();
    }
  } catch (error) {
    appUpdateDownloadError = 'The installer could not be started.';
    renderAppUpdateInfo();
    renderAppUpdateModal();
  }
}

async function startAppUpdateDownload() {
  if (!availableAppUpdate || appUpdatePhase === 'downloading') return;
  if (appUpdatePhase === 'downloaded') {
    await installDownloadedAppUpdate();
    return;
  }

  deferredAppUpdateVersion = '';
  settingsUpdateAcknowledged = true;
  appUpdatePhase = 'downloading';
  appUpdateDownloadError = '';
  renderAppUpdateInfo();
  showAppUpdateModal();
  try {
    const result = await ipcRenderer.invoke('app-update:download');
    if (!result?.ok) {
      appUpdatePhase = 'available';
      appUpdateDownloadError = result?.error
        || 'Download failed. Check your connection and try again.';
    } else {
      appUpdatePhase = 'downloaded';
      appUpdateProgress.percent = 100;
    }
  } catch (error) {
    appUpdatePhase = 'available';
    appUpdateDownloadError = 'Download failed. Check your connection and try again.';
  }
  renderAppUpdateInfo();
  renderAppUpdateModal();
}

function setupAppUpdateUI() {
  document.getElementById('app-update-btn-later')
    ?.addEventListener('click', deferAppUpdate);
  document.getElementById('app-update-btn-download')
    ?.addEventListener('click', startAppUpdateDownload);
  document.getElementById('app-update-btn-action')
    ?.addEventListener('click', startAppUpdateDownload);
  document.getElementById('app-update-btn-check')
    ?.addEventListener('click', checkForAppUpdatesManually);

  const modal = document.getElementById('app-update-modal');
  modal?.addEventListener('mousedown', event => {
    if (event.target === modal) deferAppUpdate();
  });
  document.addEventListener('keydown', event => {
    if (
      event.key === 'Escape'
      && modal?.classList.contains('show')
      && appUpdatePhase !== 'downloading'
    ) {
      event.preventDefault();
      deferAppUpdate();
    }
  });
  renderAppUpdateInfo();
}

ipcRenderer.on('app-update:available', (event, release) => {
  handleAvailableAppUpdate(release, { showPrompt: true });
});

ipcRenderer.on('app-update:status', (event, status) => {
  if (status?.status !== 'disabled') return;
  availableAppUpdate = null;
  appUpdatePhase = 'disabled';
  renderAppUpdateInfo();
});

ipcRenderer.on('app-update:progress', (event, progress) => {
  if (appUpdatePhase !== 'downloading') return;
  appUpdateProgress = {
    receivedBytes: Number(progress?.receivedBytes) || 0,
    totalBytes: Number(progress?.totalBytes) || 0,
    percent: Number.isFinite(Number(progress?.percent))
      ? Number(progress.percent)
      : null
  };
  renderAppUpdateProgress();
});

// Global audio context
let audioCtx = null;
let workingDir = ''; // Root directory containing songs folder
let workingDirectoryAvailable = null;
let workingDirectoryMonitorId = null;
const WORKING_DIRECTORY_MONITOR_INTERVAL_MS = 1000;

// Center Snap Assist Settings
let snapEnabled = false;
let snapThresholdPct = 5; // Default 5%
let skipOpeningSilence = false;
let skipEndingSilence = false;
let musicEndingWarning = false;
const DEFAULT_KEYBOARD_BINDINGS = Object.freeze({
  auto: 'KeyA',
  loopIn: 'KeyI',
  loopOut: 'KeyO',
  loopExit: 'KeyX',
  sync: 'KeyS',
  endSync: 'KeyE',
  quantize: 'KeyQ'
});
const KEYBOARD_ACTION_BUTTONS = Object.freeze({
  auto: 'btn-auto-loop',
  loopIn: 'btn-loop-in',
  loopOut: 'btn-loop-out',
  loopExit: 'btn-loop-exit',
  sync: 'btn-sync',
  endSync: 'btn-end-sync',
  quantize: 'btn-quantize'
});
const KEYBOARD_ACTION_LABELS = Object.freeze({
  auto: 'Auto Loop',
  loopIn: 'Loop In',
  loopOut: 'Loop Out',
  loopExit: 'Loop Exit',
  sync: 'Sync',
  endSync: 'End Sync',
  quantize: 'Quantize'
});
let keyboardBindings = { ...DEFAULT_KEYBOARD_BINDINGS };
let cueKeybindings = Array(8).fill('');
let selectedKeyboardTrackNum = 1;
const heldKeyboardCues = new Map();
const DEFAULT_COVER_ART_URI =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23555555"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';

function loadKeyboardBindings() {
  try {
    const savedBindings = JSON.parse(
      localStorage.getItem('notoMixer_keyboardBindings') || '{}'
    );
    Object.keys(DEFAULT_KEYBOARD_BINDINGS).forEach(action => {
      if (typeof savedBindings[action] === 'string') {
        keyboardBindings[action] = savedBindings[action];
      }
    });
  } catch (error) {
    keyboardBindings = { ...DEFAULT_KEYBOARD_BINDINGS };
  }

  try {
    const savedCueBindings = JSON.parse(
      localStorage.getItem('notoMixer_cueKeybindings') || '[]'
    );
    if (Array.isArray(savedCueBindings)) {
      cueKeybindings = Array.from(
        { length: 8 },
        (_, index) =>
          typeof savedCueBindings[index] === 'string'
            ? savedCueBindings[index]
            : ''
      );
    }
  } catch (error) {
    cueKeybindings = Array(8).fill('');
  }
}

function formatKeyboardCode(code) {
  if (!code) return 'UNASSIGNED';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6).toUpperCase()}`;
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();

  const labels = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Enter: 'ENTER',
    Tab: 'TAB',
    CapsLock: 'CAPS LOCK'
  };
  return labels[code] || code.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

function setKeybindInputValue(input, code) {
  if (!input) return;
  input.dataset.code = code || '';
  input.value = formatKeyboardCode(code);
  input.classList.remove('keybind-conflict');
  input.removeAttribute('title');
}

function populateKeyboardBindingInputs() {
  document
    .querySelectorAll('.keybind-capture-input[data-keybind-action]')
    .forEach(input => {
      setKeybindInputValue(
        input,
        keyboardBindings[input.dataset.keybindAction] || ''
      );
    });
}

function findKeybindConflict(code, { action = null, cueIndex = null } = {}) {
  if (!code) return '';

  const globalInputs = document.querySelectorAll(
    '.keybind-capture-input[data-keybind-action]'
  );
  for (const input of globalInputs) {
    const inputAction = input.dataset.keybindAction;
    const assignedCode =
      input.dataset.code !== undefined
        ? input.dataset.code
        : keyboardBindings[inputAction];
    if (inputAction !== action && assignedCode === code) {
      return KEYBOARD_ACTION_LABELS[inputAction] || inputAction;
    }
  }

  for (let index = 0; index < cueKeybindings.length; index++) {
    if (index !== cueIndex && cueKeybindings[index] === code) {
      return `Cue ${index + 1}`;
    }
  }
  return '';
}

function showKeybindConflict(input, message) {
  input.classList.remove('keybind-conflict');
  void input.offsetWidth;
  input.classList.add('keybind-conflict');
  input.title = message;
  input.value =
    message === 'Space is reserved for Play / Pause'
      ? 'SPACE RESERVED'
      : message === 'Choose a single non-modifier key'
        ? 'INVALID KEY'
        : `USED: ${message.replace(/^.* used by /, '')}`;
  clearTimeout(input._keybindConflictTimer);
  input._keybindConflictTimer = setTimeout(() => {
    input.classList.remove('keybind-conflict');
    input.value = formatKeyboardCode(input.dataset.code);
  }, 900);
}

function setupKeybindCaptureInput(input, getBindingTarget) {
  if (!input || input.dataset.keybindCaptureReady === 'true') return;
  input.dataset.keybindCaptureReady = 'true';

  input.addEventListener('focus', () => {
    input.classList.remove('keybind-conflict');
    input.select();
  });

  input.addEventListener('keydown', event => {
    event.preventDefault();
    event.stopPropagation();

    if (event.code === 'Escape') {
      input.blur();
      return;
    }

    if (event.code === 'Backspace' || event.code === 'Delete') {
      setKeybindInputValue(input, '');
      return;
    }

    if (
      event.code === 'Space' ||
      event.code === 'Tab' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      [
        'ShiftLeft',
        'ShiftRight',
        'ControlLeft',
        'ControlRight',
        'AltLeft',
        'AltRight',
        'MetaLeft',
        'MetaRight'
      ].includes(event.code)
    ) {
      const message =
        event.code === 'Space'
          ? 'Space is reserved for Play / Pause'
          : 'Choose a single non-modifier key';
      showKeybindConflict(input, message);
      return;
    }

    const target = getBindingTarget();
    const conflict = findKeybindConflict(event.code, target);
    if (conflict) {
      showKeybindConflict(
        input,
        `${formatKeyboardCode(event.code)} is used by ${conflict}`
      );
      return;
    }

    setKeybindInputValue(input, event.code);
    input.blur();
  });
}

function selectKeyboardTrack(trackNum) {
  if (trackNum !== 1 && trackNum !== 2) return;
  selectedKeyboardTrackNum = trackNum;
}

function isKeyboardShortcutBlocked(event) {
  const target = event.target;
  if (
    target &&
    target.closest &&
    target.closest('input, textarea, select, [contenteditable="true"]')
  ) {
    return true;
  }
  if (document.body.classList.contains('app-daemon-locked')) return true;
  return Boolean(
    document.querySelector(
      '#settings-modal.show, #end-sync-modal.show, #connection-modal.show, #evaluation-modal.show, #app-update-modal.show, #tablet-controller-modal.show, #cue-settings-window.show, #sample-settings-window.show, #midi-mapping-modal.show'
    )
  );
}

function setupKeyboardShortcuts() {
  [1, 2].forEach(trackNum => {
    const trackElement = document.getElementById(`track-${trackNum}`);
    if (trackElement) {
      trackElement.addEventListener(
        'pointerdown',
        () => selectKeyboardTrack(trackNum),
        true
      );
    }
  });
  selectKeyboardTrack(selectedKeyboardTrackNum);

  document
    .querySelectorAll('.keybind-capture-input[data-keybind-action]')
    .forEach(input => {
      setupKeybindCaptureInput(input, () => ({
        action: input.dataset.keybindAction
      }));
    });

  const cueKeybindInput = document.getElementById('cue-keybind-input');
  setupKeybindCaptureInput(cueKeybindInput, () => ({
    cueIndex:
      Number.isInteger(currentCueSettingsBtnIdx)
        ? currentCueSettingsBtnIdx
        : null
  }));

  document.addEventListener('keydown', event => {
    if (event.repeat || isKeyboardShortcutBlocked(event)) return;

    if (event.code === 'Space') {
      event.preventDefault();
      togglePlayTrack(selectedKeyboardTrackNum);
      return;
    }

    const action = Object.keys(keyboardBindings).find(
      actionName => keyboardBindings[actionName] === event.code
    );
    if (action) {
      event.preventDefault();
      const button = document.getElementById(
        `${KEYBOARD_ACTION_BUTTONS[action]}-${selectedKeyboardTrackNum}`
      );
      if (button && !button.disabled) button.click();
      return;
    }

    const cueIndex = cueKeybindings.indexOf(event.code);
    if (cueIndex === -1) return;

    const cueButton = document.getElementById(
      `sound-btn-${selectedKeyboardTrackNum}-${cueIndex}`
    );
    if (!cueButton) return;

    event.preventDefault();
    const isHotCue = Number.isFinite(
      tracks[selectedKeyboardTrackNum].hotCues[cueIndex]
    );
    const cueMode =
      tracks[selectedKeyboardTrackNum].cueModes[cueIndex] || 'play';
    if (isHotCue && cueMode === 'hold') {
      heldKeyboardCues.set(event.code, cueButton);
      cueButton.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
    } else if (isHotCue) {
      cueButton.click();
    } else {
      cueButton.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
    }
  });

  document.addEventListener('keyup', event => {
    const heldCueButton = heldKeyboardCues.get(event.code);
    if (!heldCueButton) return;
    heldKeyboardCues.delete(event.code);
    event.preventDefault();
    heldCueButton.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0 })
    );
  });

  window.addEventListener('blur', () => {
    heldKeyboardCues.forEach(cueButton => {
      cueButton.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, button: 0 })
      );
    });
    heldKeyboardCues.clear();
  });
}

const MIDI_ANALOG_CONTROL_TEMPLATES = Object.freeze([
  { key: 'volume', label: 'Volume', element: 'vol', min: 0, max: 100, decimals: 0 },
  { key: 'bass', label: 'Bass', element: 'bass', min: -12, max: 12, decimals: 1 },
  { key: 'low', label: 'Lows', element: 'low', min: -12, max: 12, decimals: 1 },
  { key: 'treb', label: 'Treble', element: 'treb', min: -12, max: 12, decimals: 1 },
  { key: 'inst', label: 'Instrumental', element: 'inst', min: 0, max: 100, decimals: 0 },
  { key: 'voc', label: 'Vocals', element: 'voc', min: 0, max: 100, decimals: 0 },
  { key: 'filter', label: 'Filter', element: 'filter', min: 0, max: 100, decimals: 0 },
  { key: 'pitch', label: 'Pitch', element: 'pitch', min: -12, max: 12, decimals: 1 },
  { key: 'speed', label: 'Speed / Tempo', element: 'speed', min: 50, max: 200, decimals: 0 },
  { key: 'echo', label: 'Echo', element: 'echo', min: 0, max: 100, decimals: 0 },
  { key: 'pan', label: 'Pan', element: 'pan', min: -100, max: 100, decimals: 0 },
  { key: 'reverb', label: 'Reverb', element: 'reverb', min: 0, max: 100, decimals: 0 },
  { key: 'echotime', label: 'Echo Time', element: 'echotime', min: 100, max: 1000, decimals: 0 }
]);

const MIDI_BUTTON_CONTROL_TEMPLATES = Object.freeze([
  { key: 'play', label: 'Play / Pause', button: 'btn-play' },
  { key: 'stop', label: 'Stop', button: 'btn-stop' },
  { key: 'autoLoop', label: 'Auto Loop', button: 'btn-auto-loop' },
  { key: 'loopHalf', label: 'Loop Half', button: 'btn-loop-halve' },
  { key: 'loopDouble', label: 'Loop Double', button: 'btn-loop-double' },
  { key: 'loopIn', label: 'Loop In', button: 'btn-loop-in' },
  { key: 'loopOut', label: 'Loop Out', button: 'btn-loop-out' },
  { key: 'loopExit', label: 'Loop Exit', button: 'btn-loop-exit' },
  { key: 'sync', label: 'Sync', button: 'btn-sync' },
  { key: 'endSync', label: 'End Sync (ES)', button: 'btn-end-sync' },
  { key: 'quantize', label: 'Quantize (Q)', button: 'btn-quantize' },
  { key: 'tap', label: 'Tap Tempo', button: 'btn-tap' },
  { key: 'metronome', label: 'Metronome', button: 'btn-metro' }
]);

const MIDI_CONTROL_DEFINITIONS = Object.freeze(
  [1, 2].flatMap(trackNum => {
    const analogControls = MIDI_ANALOG_CONTROL_TEMPLATES.map(control => ({
      ...control,
      id: `track${trackNum}.${control.key}`,
      trackNum,
      kind: 'continuous',
      elementId: `${control.element}-${trackNum}`
    }));
    const buttonControls = MIDI_BUTTON_CONTROL_TEMPLATES.map(control => ({
      ...control,
      id: `track${trackNum}.${control.key}`,
      trackNum,
      kind: 'button',
      buttonId: `${control.button}-${trackNum}`
    }));
    const relativeControls = [{
      id: `track${trackNum}.jog`,
      key: 'jog',
      label: 'Jog Wheel',
      trackNum,
      kind: 'relative'
    }];
    const jogTouchControls = [{
      id: `track${trackNum}.jogTouch`,
      key: 'jogTouch',
      label: 'Jog Touch',
      trackNum,
      kind: 'jogTouch'
    }];
    const soundButtons = Array.from({ length: 8 }, (_, index) => ({
      id: `track${trackNum}.button${index + 1}`,
      key: `button${index + 1}`,
      label: `Button / Cue ${index + 1}`,
      trackNum,
      kind: 'button',
      soundButtonIndex: index,
      buttonId: `sound-btn-${trackNum}-${index}`
    }));
    return [
      ...analogControls,
      ...relativeControls,
      ...jogTouchControls,
      ...buttonControls,
      ...soundButtons
    ];
  })
);

const MIDI_CONTROL_BY_ID = new Map(
  MIDI_CONTROL_DEFINITIONS.map(control => [control.id, control])
);
const MIDI_CONFIG_STORAGE_KEY = 'notoMixer_midiControllerConfig';
let midiAccess = null;
let midiInitPromise = null;
let midiSelectedInputId = '';
let midiWizard = null;
let midiControllerConfig = {
  version: 1,
  deviceId: '',
  deviceName: '',
  manufacturer: '',
  mappings: {}
};
const midiButtonStates = new Map();
const trackScratchSessions = new Map();
const DEFAULT_JOG_MAX_SPEED = 16;
const DEFAULT_JOG_INERTIA_SECONDS = 0.7;
let jogMaxSpeed = DEFAULT_JOG_MAX_SPEED;
let jogInertiaSeconds = DEFAULT_JOG_INERTIA_SECONDS;

function clampJogMaxSpeed(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? Math.max(2, Math.min(32, numericValue))
    : DEFAULT_JOG_MAX_SPEED;
}

function clampJogInertiaSeconds(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? Math.max(0, Math.min(5, numericValue))
    : DEFAULT_JOG_INERTIA_SECONDS;
}

function applyJogSpeedProfile(rawVelocity) {
  const scaledVelocity =
    Number(rawVelocity) * (jogMaxSpeed / DEFAULT_JOG_MAX_SPEED);
  return Math.max(
    -jogMaxSpeed,
    Math.min(jogMaxSpeed, scaledVelocity)
  );
}

function loadJogPhysicsSettings() {
  const savedMaxSpeed = localStorage.getItem('notoMixer_jogMaxSpeed');
  const savedInertia = localStorage.getItem('notoMixer_jogInertiaSeconds');
  jogMaxSpeed =
    savedMaxSpeed === null
      ? DEFAULT_JOG_MAX_SPEED
      : clampJogMaxSpeed(savedMaxSpeed);
  jogInertiaSeconds =
    savedInertia === null
      ? DEFAULT_JOG_INERTIA_SECONDS
      : clampJogInertiaSeconds(savedInertia);
}

function populateJogPhysicsSettingsUI() {
  const maxSpeedSlider = document.getElementById('setting-jog-max-speed');
  const maxSpeedDisplay = document.getElementById('jog-max-speed-display');
  const inertiaSlider = document.getElementById('setting-jog-inertia');
  const inertiaDisplay = document.getElementById('jog-inertia-display');

  if (maxSpeedSlider) maxSpeedSlider.value = String(jogMaxSpeed);
  if (maxSpeedDisplay) {
    maxSpeedDisplay.textContent = `${Math.round(jogMaxSpeed)}×`;
  }
  if (inertiaSlider) inertiaSlider.value = String(jogInertiaSeconds);
  if (inertiaDisplay) {
    inertiaDisplay.textContent = `${jogInertiaSeconds.toFixed(2)} s`;
  }
}

function loadMidiControllerConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(MIDI_CONFIG_STORAGE_KEY) || '{}');
    const mappings =
      saved && typeof saved.mappings === 'object' && saved.mappings
        ? saved.mappings
        : {};
    midiControllerConfig = {
      version: 1,
      deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : '',
      deviceName: typeof saved.deviceName === 'string' ? saved.deviceName : '',
      manufacturer:
        typeof saved.manufacturer === 'string' ? saved.manufacturer : '',
      mappings
    };
    midiSelectedInputId = midiControllerConfig.deviceId;
  } catch (error) {
    midiControllerConfig = {
      version: 1,
      deviceId: '',
      deviceName: '',
      manufacturer: '',
      mappings: {}
    };
  }
}

function saveMidiControllerConfig() {
  localStorage.setItem(
    MIDI_CONFIG_STORAGE_KEY,
    JSON.stringify(midiControllerConfig)
  );
  persistUserSettings();
}

function getMidiInputs() {
  return midiAccess ? Array.from(midiAccess.inputs.values()) : [];
}

function getMidiInputFromSelection() {
  return getMidiInputs().find(input => input.id === midiSelectedInputId) || null;
}

function midiInputMatchesConfig(input) {
  if (!input || !midiControllerConfig) return false;
  if (
    midiControllerConfig.deviceId &&
    input.id === midiControllerConfig.deviceId
  ) {
    return true;
  }
  return Boolean(
    midiControllerConfig.deviceName &&
    input.name === midiControllerConfig.deviceName &&
    (input.manufacturer || '') === (midiControllerConfig.manufacturer || '')
  );
}

function bindMidiInputs() {
  getMidiInputs().forEach(input => {
    input.onmidimessage = handleMidiMessage;
  });
}

async function initMidiControllers({ forceRefresh = false } = {}) {
  if (!navigator.requestMIDIAccess) {
    refreshMidiControllerUI('unsupported');
    return null;
  }
  if (midiAccess && !forceRefresh) {
    bindMidiInputs();
    refreshMidiControllerUI();
    return midiAccess;
  }
  if (midiInitPromise && !forceRefresh) return midiInitPromise;

  midiInitPromise = navigator
    .requestMIDIAccess({ sysex: false })
    .then(access => {
      midiAccess = access;
      midiAccess.onstatechange = () => {
        bindMidiInputs();
        refreshMidiControllerUI();
      };
      bindMidiInputs();
      refreshMidiControllerUI();
      return midiAccess;
    })
    .catch(error => {
      console.error('MIDI access failed:', error);
      refreshMidiControllerUI('error');
      return null;
    })
    .finally(() => {
      midiInitPromise = null;
    });
  return midiInitPromise;
}

function formatMidiDeviceName(input) {
  const manufacturer = (input.manufacturer || '').trim();
  const name = (input.name || 'MIDI Controller').trim();
  if (!manufacturer || name.toLowerCase().includes(manufacturer.toLowerCase())) {
    return name;
  }
  return `${manufacturer} ${name}`;
}

function formatMidiMapping(mapping) {
  if (!mapping) return '';
  const type =
    mapping.type === 'cc'
      ? `CC ${mapping.number}`
      : mapping.type === 'note'
        ? `NOTE ${mapping.number}`
        : 'PITCH BEND';
  const channel = `CH ${Number(mapping.channel) + 1}`;
  if (mapping.kind === 'continuous') {
    const direction = mapping.invert ? ' · INV' : '';
    return `${type} · ${channel} · ${mapping.inputMin}–${mapping.inputMax}${direction}`;
  }
  if (mapping.kind === 'relative') {
    const direction = mapping.invert ? ' · INV' : '';
    return `${type} · ${channel} · RELATIVE${direction}`;
  }
  return `${type} · ${channel}`;
}

function refreshMidiControllerUI(forcedState = '') {
  const select = document.getElementById('midi-controller-select');
  const state = document.getElementById('midi-controller-state');
  const startButton = document.getElementById('btn-midi-start-mapping');
  const clearButton = document.getElementById('btn-midi-clear-mapping');
  const mappingCount = document.getElementById('midi-mapping-count');
  const description = document.getElementById('midi-profile-description');
  const summary = document.getElementById('midi-mapping-summary');
  if (!select || !state) return;

  const inputs = getMidiInputs().filter(input => input.state !== 'disconnected');
  const previousSelection = select.value || midiSelectedInputId;
  select.innerHTML = '';

  if (!inputs.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent =
      forcedState === 'unsupported'
        ? 'Web MIDI is not available'
        : 'No MIDI controller detected';
    select.appendChild(option);
    midiSelectedInputId = '';
  } else {
    inputs.forEach(input => {
      const option = document.createElement('option');
      option.value = input.id;
      option.textContent = formatMidiDeviceName(input);
      select.appendChild(option);
    });

    const configuredInput = inputs.find(midiInputMatchesConfig);
    const preferredInput =
      inputs.find(input => input.id === previousSelection) ||
      configuredInput ||
      inputs[0];
    select.value = preferredInput.id;
    midiSelectedInputId = preferredInput.id;
  }

  state.classList.remove('connected', 'error');
  if (forcedState === 'unsupported' || forcedState === 'error') {
    state.textContent =
      forcedState === 'unsupported' ? 'UNSUPPORTED' : 'ACCESS ERROR';
    state.classList.add('error');
  } else if (inputs.length) {
    state.textContent = `${inputs.length} CONNECTED`;
    state.classList.add('connected');
  } else {
    state.textContent = midiAccess ? 'NOT CONNECTED' : 'CHECKING...';
  }

  const mappedEntries = Object.entries(midiControllerConfig.mappings).filter(
    ([controlId, mapping]) => MIDI_CONTROL_BY_ID.has(controlId) && mapping
  );
  if (mappingCount) {
    mappingCount.textContent = `${mappedEntries.length} MAPPED`;
  }
  if (description) {
    description.textContent = mappedEntries.length
      ? `${midiControllerConfig.deviceName || 'MIDI controller'} profile is active. Start configuration to replace it.`
      : 'No MIDI mapping has been configured.';
  }
  if (summary) {
    summary.innerHTML = '';
    if (!mappedEntries.length) {
      const empty = document.createElement('span');
      empty.className = 'settings-desc';
      empty.textContent = 'Mapped controls will appear here.';
      summary.appendChild(empty);
    } else {
      mappedEntries.forEach(([controlId, mapping]) => {
        const definition = MIDI_CONTROL_BY_ID.get(controlId);
        const chip = document.createElement('span');
        chip.className = 'midi-mapping-chip';
        chip.textContent = `T${definition.trackNum} ${definition.label}`;
        chip.title = formatMidiMapping(mapping);
        summary.appendChild(chip);
      });
    }
  }

  if (startButton) startButton.disabled = !inputs.length;
  if (clearButton) clearButton.disabled = !mappedEntries.length;
}

function setupMidiControllerUI() {
  const select = document.getElementById('midi-controller-select');
  const refreshButton = document.getElementById('btn-midi-refresh');
  const startButton = document.getElementById('btn-midi-start-mapping');
  const clearButton = document.getElementById('btn-midi-clear-mapping');
  const cancelButton = document.getElementById('btn-midi-cancel');
  const skipButton = document.getElementById('btn-midi-skip');
  const acceptButton = document.getElementById('btn-midi-accept');

  if (select) {
    select.addEventListener('change', () => {
      midiSelectedInputId = select.value;
    });
  }
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      initMidiControllers({ forceRefresh: true });
    });
  }
  if (startButton) {
    startButton.addEventListener('click', async () => {
      await initMidiControllers();
      startMidiMappingWizard();
    });
  }
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      if (
        !window.confirm(
          'Clear the saved MIDI controller mapping? This does not change keyboard shortcuts.'
        )
      ) {
        return;
      }
      midiControllerConfig = {
        version: 1,
        deviceId: '',
        deviceName: '',
        manufacturer: '',
        mappings: {}
      };
      midiButtonStates.clear();
      saveMidiControllerConfig();
      refreshMidiControllerUI();
      logConsole('MIDI: Controller mapping cleared', 'system');
    });
  }
  if (cancelButton) {
    cancelButton.addEventListener('click', cancelMidiMappingWizard);
  }
  if (skipButton) {
    skipButton.addEventListener('click', skipMidiMappingStep);
  }
  if (acceptButton) {
    acceptButton.addEventListener('click', finalizeMidiContinuousCandidate);
  }

  document.addEventListener('keydown', event => {
    const modal = document.getElementById('midi-mapping-modal');
    if (
      event.key === 'Escape' &&
      modal &&
      modal.classList.contains('show')
    ) {
      event.preventDefault();
      cancelMidiMappingWizard();
    }
  });
}

function startMidiMappingWizard() {
  const input = getMidiInputFromSelection();
  if (!input) {
    refreshMidiControllerUI(midiAccess ? '' : 'error');
    return;
  }

  midiWizard = {
    inputId: input.id,
    deviceName: input.name || 'MIDI Controller',
    manufacturer: input.manufacturer || '',
    index: 0,
    draftMappings: {},
    candidate: null,
    autoAcceptTimer: null,
    stepLocked: false
  };
  const modal = document.getElementById('midi-mapping-modal');
  if (modal) modal.classList.add('show');
  renderMidiMappingStep();
}

function clearMidiWizardTimer() {
  if (midiWizard && midiWizard.autoAcceptTimer) {
    clearTimeout(midiWizard.autoAcceptTimer);
    midiWizard.autoAcceptTimer = null;
  }
}

function renderMidiMappingStep() {
  if (!midiWizard) return;
  if (midiWizard.index >= MIDI_CONTROL_DEFINITIONS.length) {
    completeMidiMappingWizard();
    return;
  }

  clearMidiWizardTimer();
  midiWizard.candidate = null;
  midiWizard.stepLocked = false;
  const definition = MIDI_CONTROL_DEFINITIONS[midiWizard.index];
  const isContinuous = definition.kind === 'continuous';
  const isRelative = definition.kind === 'relative';
  const isJogTouch = definition.kind === 'jogTouch';
  const total = MIDI_CONTROL_DEFINITIONS.length;
  const progress = ((midiWizard.index + 1) / total) * 100;

  const progressText = document.getElementById('midi-mapping-progress-text');
  const progressFill = document.getElementById('midi-mapping-progress-fill');
  const group = document.getElementById('midi-mapping-group');
  const control = document.getElementById('midi-mapping-control');
  const instruction = document.getElementById('midi-mapping-instruction');
  const status = document.getElementById('midi-learn-status');
  const message = document.getElementById('midi-learn-message');
  const range = document.getElementById('midi-learn-range');
  const rangeFill = document.getElementById('midi-learn-range-fill');
  const rangeText = document.getElementById('midi-learn-range-text');
  const indicator = document.getElementById('midi-learn-indicator');
  const acceptButton = document.getElementById('btn-midi-accept');

  if (progressText) progressText.textContent = `${midiWizard.index + 1} / ${total}`;
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (group) group.textContent = `TRACK ${definition.trackNum}`;
  if (control) control.textContent = definition.label.toUpperCase();
  if (instruction) {
    if (isContinuous) {
      instruction.textContent =
        'Move the physical control to minimum, then maximum. Finish at maximum.';
    } else if (isRelative) {
      instruction.textContent =
        'Turn the jog backward first, then forward. Both directions are detected automatically.';
    } else if (isJogTouch) {
      instruction.textContent =
        'Press the top of the jog wheel. Holding it will stop the track like vinyl.';
    } else {
      instruction.textContent = 'Press the physical button you want to assign.';
    }
  }
  if (status) status.textContent = 'WAITING FOR MIDI INPUT';
  if (message) message.textContent = 'No message detected';
  if (range) range.classList.toggle('hidden', !isContinuous && !isRelative);
  if (rangeFill) rangeFill.style.width = '0%';
  if (rangeText) {
    rangeText.classList.toggle('hidden', !isContinuous && !isRelative);
    rangeText.textContent = isRelative
      ? 'BACKWARD: WAITING · FORWARD: WAITING'
      : 'RANGE: --';
  }
  if (indicator) indicator.classList.remove('received');
  if (acceptButton) {
    acceptButton.disabled = true;
    acceptButton.style.visibility = isContinuous ? 'visible' : 'hidden';
  }
}

function skipMidiMappingStep() {
  if (!midiWizard || midiWizard.stepLocked) return;
  clearMidiWizardTimer();
  const definition = MIDI_CONTROL_DEFINITIONS[midiWizard.index];
  delete midiWizard.draftMappings[definition.id];
  midiWizard.index += 1;
  renderMidiMappingStep();
}

function cancelMidiMappingWizard() {
  if (!midiWizard) return;
  clearMidiWizardTimer();
  midiWizard = null;
  const modal = document.getElementById('midi-mapping-modal');
  if (modal) modal.classList.remove('show');
  refreshMidiControllerUI();
  logConsole('MIDI: Controller configuration cancelled', 'system');
}

function completeMidiMappingWizard() {
  if (!midiWizard) return;
  clearMidiWizardTimer();
  midiControllerConfig = {
    version: 1,
    deviceId: midiWizard.inputId,
    deviceName: midiWizard.deviceName,
    manufacturer: midiWizard.manufacturer,
    mappings: midiWizard.draftMappings
  };
  midiSelectedInputId = midiWizard.inputId;
  midiButtonStates.clear();
  saveMidiControllerConfig();
  const mappedCount = Object.keys(midiWizard.draftMappings).length;
  midiWizard = null;
  const modal = document.getElementById('midi-mapping-modal');
  if (modal) modal.classList.remove('show');
  refreshMidiControllerUI();
  logConsole(
    `MIDI: Controller configured with ${mappedCount} mapped controls`,
    'system'
  );
}

function parseMidiMessage(data) {
  if (!data || data.length < 1) return null;
  const status = data[0];
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const number = Number(data[1] || 0);
  const value = Number(data[2] || 0);

  if (command === 0xb0) {
    return { type: 'cc', channel, number, value, valueMax: 127 };
  }
  if (command === 0x90) {
    return {
      type: 'note',
      channel,
      number,
      value,
      valueMax: 127,
      active: value > 0
    };
  }
  if (command === 0x80) {
    return {
      type: 'note',
      channel,
      number,
      value: 0,
      valueMax: 127,
      active: false
    };
  }
  if (command === 0xe0) {
    return {
      type: 'pitchbend',
      channel,
      number: 0,
      value: number | (value << 7),
      valueMax: 16383
    };
  }
  return null;
}

function getMidiMessageSignature(message) {
  return `${message.type}:${message.channel}:${message.number}`;
}

function midiMappingMatchesMessage(mapping, message) {
  return Boolean(
    mapping &&
    message &&
    mapping.type === message.type &&
    Number(mapping.channel) === message.channel &&
    Number(mapping.number) === message.number
  );
}

function describeMidiMessage(message) {
  const type =
    message.type === 'cc'
      ? `CC ${message.number}`
      : message.type === 'note'
        ? `NOTE ${message.number}`
        : 'PITCH BEND';
  return `${type} · CH ${message.channel + 1} · VALUE ${message.value}`;
}

function flashMidiLearnIndicator() {
  const indicator = document.getElementById('midi-learn-indicator');
  if (!indicator) return;
  indicator.classList.add('received');
  clearTimeout(indicator._midiFlashTimer);
  indicator._midiFlashTimer = setTimeout(() => {
    indicator.classList.remove('received');
  }, 120);
}

function findMidiDraftConflict(mapping, currentControlId) {
  if (!midiWizard) return '';
  const signature = getMidiMessageSignature(mapping);
  for (const [controlId, existing] of Object.entries(
    midiWizard.draftMappings
  )) {
    if (
      controlId !== currentControlId &&
      getMidiMessageSignature(existing) === signature
    ) {
      return MIDI_CONTROL_BY_ID.get(controlId)?.label || controlId;
    }
  }
  return '';
}

function showMidiLearnConflict(conflictLabel) {
  if (!midiWizard) return;
  clearMidiWizardTimer();
  midiWizard.candidate = null;
  const status = document.getElementById('midi-learn-status');
  const message = document.getElementById('midi-learn-message');
  const acceptButton = document.getElementById('btn-midi-accept');
  if (status) status.textContent = 'INPUT ALREADY MAPPED';
  if (message) message.textContent = `Already used by ${conflictLabel}. Move another control or Skip.`;
  if (acceptButton) acceptButton.disabled = true;
}

function detectMidiRelativeMode(value) {
  if (value >= 32 && value <= 96) return 'offset64';
  return 'twosComplement';
}

function decodeMidiRelativeDelta(value, mode) {
  if (mode === 'twosComplement') {
    if (value === 0 || value === 64) return 0;
    return value <= 63 ? value : value - 128;
  }
  return value - 64;
}

function handleMidiRelativeLearnMessage(definition, message) {
  if (!midiWizard || message.type !== 'cc') return;
  const signature = getMidiMessageSignature(message);

  if (
    !midiWizard.candidate ||
    midiWizard.candidate.signature !== signature
  ) {
    midiWizard.candidate = {
      signature,
      type: message.type,
      channel: message.channel,
      number: message.number,
      relativeMode: detectMidiRelativeMode(message.value),
      backwardSign: 0,
      backwardCount: 0,
      forwardSign: 0,
      forwardCount: 0
    };
  }

  const candidate = midiWizard.candidate;
  const delta = decodeMidiRelativeDelta(
    message.value,
    candidate.relativeMode
  );
  if (delta === 0) return;
  const directionSign = Math.sign(delta);

  if (!candidate.backwardSign) {
    candidate.backwardSign = directionSign;
    candidate.backwardCount = 1;
  } else if (
    !candidate.forwardSign &&
    directionSign === candidate.backwardSign
  ) {
    candidate.backwardCount += 1;
  } else if (
    candidate.backwardCount >= 2 &&
    directionSign !== candidate.backwardSign
  ) {
    candidate.forwardSign = directionSign;
    candidate.forwardCount += 1;
  }

  const status = document.getElementById('midi-learn-status');
  const rangeFill = document.getElementById('midi-learn-range-fill');
  const rangeText = document.getElementById('midi-learn-range-text');
  const backwardReady = candidate.backwardCount >= 2;
  const forwardReady = candidate.forwardCount >= 2;
  if (status) {
    status.textContent = forwardReady
      ? 'JOG DIRECTIONS DETECTED'
      : backwardReady
        ? 'BACKWARD DETECTED · NOW TURN FORWARD'
        : 'JOG DETECTED · KEEP TURNING BACKWARD';
  }
  if (rangeFill) {
    rangeFill.style.width = forwardReady ? '100%' : backwardReady ? '50%' : '20%';
  }
  if (rangeText) {
    rangeText.textContent =
      `BACKWARD: ${backwardReady ? 'OK' : 'WAITING'} · ` +
      `FORWARD: ${forwardReady ? 'OK' : 'WAITING'}`;
  }
  if (!forwardReady) return;

  const mapping = {
    kind: 'relative',
    type: candidate.type,
    channel: candidate.channel,
    number: candidate.number,
    relativeMode: candidate.relativeMode,
    invert: candidate.forwardSign < 0,
    secondsPerStep: 0.0125
  };
  const conflict = findMidiDraftConflict(mapping, definition.id);
  if (conflict) {
    showMidiLearnConflict(conflict);
    return;
  }

  midiWizard.draftMappings[definition.id] = mapping;
  midiWizard.stepLocked = true;
  setTimeout(() => {
    if (!midiWizard) return;
    midiWizard.index += 1;
    renderMidiMappingStep();
  }, 220);
}

function handleMidiWizardMessage(message) {
  if (!midiWizard || midiWizard.stepLocked) return;
  const definition = MIDI_CONTROL_DEFINITIONS[midiWizard.index];
  if (!definition) return;

  flashMidiLearnIndicator();
  const messageElement = document.getElementById('midi-learn-message');
  if (messageElement) messageElement.textContent = describeMidiMessage(message);

  if (definition.kind === 'relative') {
    handleMidiRelativeLearnMessage(definition, message);
    return;
  }

  if (definition.kind === 'continuous') {
    if (message.type !== 'cc' && message.type !== 'pitchbend') return;
    const signature = getMidiMessageSignature(message);
    if (
      !midiWizard.candidate ||
      midiWizard.candidate.signature !== signature
    ) {
      midiWizard.candidate = {
        signature,
        type: message.type,
        channel: message.channel,
        number: message.number,
        valueMax: message.valueMax,
        inputMin: message.value,
        inputMax: message.value,
        firstValue: message.value,
        lastValue: message.value
      };
    } else {
      midiWizard.candidate.inputMin = Math.min(
        midiWizard.candidate.inputMin,
        message.value
      );
      midiWizard.candidate.inputMax = Math.max(
        midiWizard.candidate.inputMax,
        message.value
      );
      midiWizard.candidate.lastValue = message.value;
    }

    const candidate = midiWizard.candidate;
    const detectedRange = candidate.inputMax - candidate.inputMin;
    const rangeRatio = detectedRange / candidate.valueMax;
    const status = document.getElementById('midi-learn-status');
    const rangeFill = document.getElementById('midi-learn-range-fill');
    const rangeText = document.getElementById('midi-learn-range-text');
    const acceptButton = document.getElementById('btn-midi-accept');
    if (status) {
      status.textContent =
        rangeRatio >= 0.78
          ? 'FULL RANGE DETECTED'
          : 'DETECTED · MOVE THROUGH FULL RANGE';
    }
    if (rangeFill) {
      rangeFill.style.width = `${Math.min(100, rangeRatio * 100)}%`;
    }
    if (rangeText) {
      rangeText.textContent = `RANGE: ${candidate.inputMin} – ${candidate.inputMax}`;
    }
    if (acceptButton) {
      acceptButton.disabled = detectedRange < Math.max(4, candidate.valueMax * 0.05);
    }

    clearMidiWizardTimer();
    if (rangeRatio >= 0.78) {
      midiWizard.autoAcceptTimer = setTimeout(
        finalizeMidiContinuousCandidate,
        450
      );
    }
    return;
  }

  if (
    (message.type !== 'note' && message.type !== 'cc') ||
    (message.type === 'note' && !message.active) ||
    (message.type === 'cc' && message.value === 0)
  ) {
    return;
  }

  const mapping = {
    kind: 'button',
    type: message.type,
    channel: message.channel,
    number: message.number,
    activeThreshold:
      message.type === 'note'
        ? 1
        : message.value >= 64
          ? 64
          : Math.max(1, Math.floor(message.value / 2))
  };
  const conflict = findMidiDraftConflict(mapping, definition.id);
  if (conflict) {
    showMidiLearnConflict(conflict);
    return;
  }

  midiWizard.draftMappings[definition.id] = mapping;
  midiWizard.stepLocked = true;
  const status = document.getElementById('midi-learn-status');
  if (status) status.textContent = 'BUTTON MAPPED';
  setTimeout(() => {
    if (!midiWizard) return;
    midiWizard.index += 1;
    renderMidiMappingStep();
  }, 180);
}

function finalizeMidiContinuousCandidate() {
  if (
    !midiWizard ||
    midiWizard.stepLocked ||
    !midiWizard.candidate
  ) {
    return;
  }
  const candidate = midiWizard.candidate;
  if (candidate.inputMax - candidate.inputMin < 1) return;
  const definition = MIDI_CONTROL_DEFINITIONS[midiWizard.index];
  const distanceToMin = Math.abs(candidate.lastValue - candidate.inputMin);
  const distanceToMax = Math.abs(candidate.lastValue - candidate.inputMax);
  const mapping = {
    kind: 'continuous',
    type: candidate.type,
    channel: candidate.channel,
    number: candidate.number,
    inputMin: candidate.inputMin,
    inputMax: candidate.inputMax,
    invert: distanceToMin < distanceToMax
  };
  const conflict = findMidiDraftConflict(mapping, definition.id);
  if (conflict) {
    showMidiLearnConflict(conflict);
    return;
  }

  midiWizard.draftMappings[definition.id] = mapping;
  midiWizard.stepLocked = true;
  clearMidiWizardTimer();
  const status = document.getElementById('midi-learn-status');
  if (status) status.textContent = 'RANGE MAPPED';
  setTimeout(() => {
    if (!midiWizard) return;
    midiWizard.index += 1;
    renderMidiMappingStep();
  }, 180);
}

function applyMidiContinuousControl(definition, mapping, messageValue) {
  const inputSpan = mapping.inputMax - mapping.inputMin;
  if (inputSpan <= 0) return;
  let normalized = (messageValue - mapping.inputMin) / inputSpan;
  normalized = Math.max(0, Math.min(1, normalized));
  if (mapping.invert) normalized = 1 - normalized;
  let value =
    definition.min + normalized * (definition.max - definition.min);
  const decimalScale = Math.pow(10, definition.decimals || 0);
  value = Math.round(value * decimalScale) / decimalScale;

  if (definition.key === 'volume') {
    setVolume(definition.trackNum, value);
    return;
  }

  const input = document.getElementById(definition.elementId);
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function triggerMidiButtonControl(definition) {
  const button = document.getElementById(definition.buttonId);
  if (!button || button.disabled) return;

  if (Number.isInteger(definition.soundButtonIndex)) {
    const cueIndex = definition.soundButtonIndex;
    const track = tracks[definition.trackNum];
    const isHotCue = Number.isFinite(track.hotCues[cueIndex]);
    const cueMode = track.cueModes[cueIndex] || 'play';
    if (isHotCue && cueMode === 'play') {
      button.click();
    } else {
      button.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
    }
    return;
  }

  button.click();
}

function releaseMidiButtonControl(definition) {
  if (!Number.isInteger(definition.soundButtonIndex)) return;
  const button = document.getElementById(definition.buttonId);
  if (!button) return;
  button.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, button: 0 })
  );
}

function applyMidiJogControl(definition, mapping, messageValue) {
  let relativeDelta = decodeMidiRelativeDelta(
    messageValue,
    mapping.relativeMode
  );
  if (mapping.invert) relativeDelta *= -1;
  if (relativeDelta === 0) return;

  const secondsPerStep = Number(mapping.secondsPerStep) || 0.0125;
  const timeDelta = Math.max(
    -1.5,
    Math.min(1.5, relativeDelta * secondsPerStep)
  );
  moveTrackScratch(definition.trackNum, timeDelta, { autoRelease: true });
}

function getTrackScratchStems(trackNum) {
  const track = tracks[trackNum];
  if (!track || track.isSynth) return [];

  const stems = [];
  if (track.stems.main.exists && track.stems.main.audio) {
    stems.push({
      stem: track.stems.main,
      gainNode: track.stems.main.gainNode
    });
  }
  if (track.stems.vocals.exists && track.stems.vocals.audio) {
    stems.push({
      stem: track.stems.vocals,
      gainNode: track.stems.vocals.gainNode
    });
  }
  track.stems.inst.audios.forEach(item => {
    if (item.audio) {
      stems.push({
        stem: item,
        gainNode: track.stems.inst.gainNode
      });
    }
  });
  return stems;
}

function resolveTrackTimeWithinActiveLoop(
  trackNum,
  requestedTime,
  duration = Number.POSITIVE_INFINITY
) {
  const track = tracks[trackNum];
  const finiteDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : Number.POSITIVE_INFINITY;
  const clampToTrack = time => Math.max(0, Math.min(finiteDuration, time));
  const numericTime = Number(requestedTime);
  const safeRequestedTime = Number.isFinite(numericTime) ? numericTime : 0;

  if (
    !track?.loopEnabled ||
    !track.loopRepeatEnabled ||
    !Number.isFinite(track.loopStartTime) ||
    !Number.isFinite(track.loopEndTime)
  ) {
    return {
      time: clampToTrack(safeRequestedTime),
      wrapped: false
    };
  }

  const loopStart = clampToTrack(track.loopStartTime);
  const loopEnd = clampToTrack(track.loopEndTime);
  const loopDuration = loopEnd - loopStart;
  if (loopDuration <= 0.001) {
    return {
      time: clampToTrack(safeRequestedTime),
      wrapped: false
    };
  }

  const wrapped = safeRequestedTime < loopStart || safeRequestedTime >= loopEnd;
  if (!wrapped) {
    return {
      time: safeRequestedTime,
      wrapped: false
    };
  }

  const loopOffset =
    ((safeRequestedTime - loopStart) % loopDuration + loopDuration) % loopDuration;
  return {
    time: loopStart + loopOffset,
    wrapped: true
  };
}

function updateTrackScratchSourceClock(
  session,
  now = audioCtx?.currentTime
) {
  if (
    !session ||
    !Number.isFinite(now) ||
    !Number.isFinite(session.sourceClockAudioTime)
  ) {
    return session?.sourceClockMediaTime ?? session?.currentTime ?? 0;
  }

  const elapsed = Math.max(0, now - session.sourceClockAudioTime);
  const refAudio = session.stems[0]?.stem.audio;
  const maxTime =
    refAudio && Number.isFinite(refAudio.duration)
      ? Math.max(0, refAudio.duration - 0.02)
      : Number.POSITIVE_INFINITY;
  const nextPosition = resolveTrackTimeWithinActiveLoop(
    session.trackNum,
    session.sourceClockMediaTime +
      session.sourceClockVelocity * elapsed,
    maxTime
  );
  session.sourceClockMediaTime = nextPosition.time;
  session.sourceClockAudioTime = now;
  return session.sourceClockMediaTime;
}

function stopTrackScratchSources(session, fadeSeconds = 0) {
  if (!session) return;
  if (session.sources.length > 0 && audioCtx) {
    updateTrackScratchSourceClock(session, audioCtx.currentTime);
  }
  const sources = session.sources.splice(0);
  session.direction = null;
  session.sourceClockVelocity = 0;
  session.sourceClockAudioTime = null;

  sources.forEach(item => {
    const disconnect = () => {
      try {
        item.source.stop();
      } catch (error) {}
      try {
        item.source.disconnect();
        item.gain.disconnect();
      } catch (error) {}
    };

    if (fadeSeconds > 0 && audioCtx) {
      try {
        const now = audioCtx.currentTime;
        item.gain.gain.cancelScheduledValues(now);
        item.gain.gain.setValueAtTime(
          Number.isFinite(item.gain.gain.value) ? item.gain.gain.value : 1,
          now
        );
        item.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
        setTimeout(disconnect, fadeSeconds * 1000 + 20);
        return;
      } catch (error) {}
    }
    disconnect();
  });
}

function startTrackScratch(trackNum, { explicitHold = false } = {}) {
  const existingSession = trackScratchSessions.get(trackNum);
  if (existingSession) {
    cancelTrackScratchHandoffPrime(existingSession);
    if (existingSession.physicsFrame) {
      cancelAnimationFrame(existingSession.physicsFrame);
      existingSession.physicsFrame = null;
    }
    existingSession.coasting = false;
    if (explicitHold) existingSession.explicitHold = true;
    clearTimeout(existingSession.autoReleaseTimer);
    existingSession.autoReleaseTimer = null;
    return true;
  }

  const track = tracks[trackNum];
  if (!track || track.isSynth) return false;
  initAudio(trackNum);

  const stems = getTrackScratchStems(trackNum);
  const refAudio = stems[0]?.stem.audio;
  if (
    !refAudio ||
    !Number.isFinite(refAudio.duration) ||
    refAudio.duration <= 0
  ) {
    return false;
  }

  if (audioCtx?.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }

  const initialPosition = resolveTrackTimeWithinActiveLoop(
    trackNum,
    refAudio.currentTime,
    Math.max(0, refAudio.duration - 0.02)
  );
  const session = {
    trackNum,
    stems,
    wasPlaying: track.isPlaying,
    explicitHold,
    currentTime: initialPosition.time,
    lastMoveAt: performance.now(),
    velocity: 0,
    direction: null,
    sources: [],
    sourceIdleTimer: null,
    autoReleaseTimer: null,
    coasting: false,
    physicsFrame: null,
    lastPhysicsAt: 0,
    coastStartedAt: 0,
    coastStartVelocity: 0,
    sourceClockAudioTime: null,
    sourceClockMediaTime: initialPosition.time,
    sourceClockVelocity: 0,
    handoffPrimed: false
  };

  stems.forEach(({ stem }) => stem.audio.pause());
  trackScratchSessions.set(trackNum, session);
  if (initialPosition.wrapped) {
    setTrackMediaTime(trackNum, session.currentTime);
  }
  cancelTrackWaveformReset(trackNum);
  handleTrackProgress(trackNum, true);
  return true;
}

function startTrackScratchSources(session, targetRate) {
  if (!session.wasPlaying || !audioCtx) return;
  const isForward = targetRate >= 0;
  const absRate = Math.max(0.01, Math.abs(targetRate));
  const mustRestart =
    session.direction === null ||
    session.direction !== isForward ||
    session.sources.length === 0;

  if (mustRestart) {
    stopTrackScratchSources(session);
    session.direction = isForward;
    session.sourceClockAudioTime = audioCtx.currentTime;
    session.sourceClockMediaTime = session.currentTime;
    session.sourceClockVelocity = targetRate;

    session.stems.forEach(({ stem, gainNode }) => {
      const buffer = isForward ? stem.buffer : stem.reversedBuffer;
      if (!buffer || !gainNode) return;

      try {
        const source = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        source.buffer = buffer;
        source.loop = false;
        source.connect(gain);
        gain.connect(gainNode);

        const rawOffset = isForward
          ? session.currentTime
          : buffer.duration - session.currentTime;
        const maxOffset = Math.max(0, buffer.duration - 0.001);
        const offset = Math.max(0, Math.min(maxOffset, rawOffset));
        source.playbackRate.setValueAtTime(absRate, audioCtx.currentTime);
        source.start(0, offset);

        const sourceEntry = { source, gain, stem };
        source.onended = () => {
          const index = session.sources.indexOf(sourceEntry);
          if (index >= 0) session.sources.splice(index, 1);
        };
        session.sources.push(sourceEntry);
      } catch (error) {}
    });
    return;
  }

  const now = audioCtx.currentTime;
  updateTrackScratchSourceClock(session, now);
  session.sourceClockVelocity = targetRate;
  session.sources.forEach(item => {
    try {
      item.source.playbackRate.cancelScheduledValues(now);
      item.source.playbackRate.setValueAtTime(absRate, now);
    } catch (error) {}
  });
}

function moveTrackScratch(
  trackNum,
  timeDelta,
  { autoRelease = false, elapsedSeconds: providedElapsed = null } = {}
) {
  const deltaSeconds = Number(timeDelta);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return;
  if (!trackScratchSessions.has(trackNum)) {
    if (!startTrackScratch(trackNum)) return;
  }

  const session = trackScratchSessions.get(trackNum);
  const refAudio = session?.stems[0]?.stem.audio;
  if (!session || !refAudio) return;

  cancelTrackScratchHandoffPrime(session);
  if (session.physicsFrame) {
    cancelAnimationFrame(session.physicsFrame);
    session.physicsFrame = null;
  }
  session.coasting = false;

  const now = performance.now();
  const measuredElapsed = Number(providedElapsed);
  const elapsedSeconds =
    Number.isFinite(measuredElapsed) && measuredElapsed > 0
      ? Math.max(0.004, Math.min(0.12, measuredElapsed))
      : Math.max(0.008, Math.min(0.06, (now - session.lastMoveAt) / 1000));
  session.lastMoveAt = now;

  const duration = Number.isFinite(refAudio.duration)
    ? Math.max(0, refAudio.duration - 0.02)
    : Number.POSITIVE_INFINITY;
  const nextPosition = resolveTrackTimeWithinActiveLoop(
    trackNum,
    session.currentTime + deltaSeconds,
    duration
  );
  session.currentTime = nextPosition.time;

  let targetRate = deltaSeconds / elapsedSeconds;
  if (Math.abs(targetRate) >= 1) {
    targetRate =
      Math.sign(targetRate) *
      (1 + Math.pow(Math.abs(targetRate) - 1, 0.78));
  }
  targetRate = applyJogSpeedProfile(targetRate);

  const changedDirection =
    session.velocity !== 0 &&
    Math.sign(session.velocity) !== Math.sign(targetRate);
  session.velocity = changedDirection
    ? targetRate
    : session.velocity * 0.24 + targetRate * 0.76;

  cancelTrackWaveformReset(trackNum);
  setTrackMediaTime(trackNum, session.currentTime);
  handleTrackProgress(trackNum, true);
  if (nextPosition.wrapped) {
    stopTrackScratchSources(session, 0.008);
  }
  startTrackScratchSources(session, session.velocity);

  clearTimeout(session.sourceIdleTimer);
  session.sourceIdleTimer = setTimeout(() => {
    session.velocity = 0;
    stopTrackScratchSources(session, 0.025);
  }, 110);

  clearTimeout(session.autoReleaseTimer);
  if (autoRelease && !session.explicitHold) {
    session.autoReleaseTimer = setTimeout(() => {
      endTrackScratch(trackNum);
    }, 80);
  }
}

function fadeTrackAudioIn(trackNum, audio, durationMs = 90) {
  const startedAt = performance.now();
  const fadeIn = () => {
    if (!tracks[trackNum].isPlaying) {
      audio.volume = 1;
      return;
    }
    const progress = Math.min(
      1,
      (performance.now() - startedAt) / Math.max(1, durationMs)
    );
    audio.volume = Math.sin(progress * Math.PI * 0.5);
    if (progress < 1) requestAnimationFrame(fadeIn);
  };
  fadeIn();
}

function primeTrackScratchHandoff(
  session,
  { remainingSeconds = 0, normalVelocity = 1 } = {}
) {
  if (!session || session.handoffPrimed || !session.wasPlaying) return;
  const track = tracks[session.trackNum];
  if (!track?.isPlaying) return;

  const refAudio = session.stems[0]?.stem.audio;
  const maxTime =
    refAudio && Number.isFinite(refAudio.duration)
      ? Math.max(0, refAudio.duration - 0.02)
      : Number.POSITIVE_INFINITY;
  const predictedExtraTravel =
    (session.velocity - normalVelocity) *
    Math.max(0, remainingSeconds) /
    4;
  const preRollPosition = resolveTrackTimeWithinActiveLoop(
    session.trackNum,
    session.currentTime + predictedExtraTravel,
    maxTime
  );

  session.handoffPrimed = true;
  session.stems.forEach(({ stem }) => {
    const audio = stem.audio;
    audio.volume = 0;
    audio.currentTime = preRollPosition.time;
    audio.preservesPitch = false;
    audio.playbackRate = track.speedVal;
    audio.play().catch(() => {});
  });
}

function cancelTrackScratchHandoffPrime(session) {
  if (!session?.handoffPrimed) return;
  session.handoffPrimed = false;
  session.stems.forEach(({ stem }) => {
    stem.audio.pause();
    stem.audio.volume = 1;
  });
}

function completeTrackScratch(session, { fadeSeconds = 0.1 } = {}) {
  if (!session || trackScratchSessions.get(session.trackNum) !== session) return;
  const trackNum = session.trackNum;
  const track = tracks[trackNum];
  trackScratchSessions.delete(trackNum);
  clearTimeout(session.sourceIdleTimer);
  clearTimeout(session.autoReleaseTimer);
  if (session.physicsFrame) {
    cancelAnimationFrame(session.physicsFrame);
    session.physicsFrame = null;
  }

  const refAudio = session.stems[0]?.stem.audio;
  let audibleScratchTime = session.currentTime;
  if (session.wasPlaying && session.sources.length > 0 && audioCtx) {
    audibleScratchTime = updateTrackScratchSourceClock(
      session,
      audioCtx.currentTime
    );
  } else if (
    session.wasPlaying &&
    session.sourceClockAudioTime === null &&
    Number.isFinite(session.sourceClockMediaTime)
  ) {
    audibleScratchTime = session.sourceClockMediaTime;
  }
  const finalPosition = resolveTrackTimeWithinActiveLoop(
    trackNum,
    audibleScratchTime,
    refAudio && Number.isFinite(refAudio.duration)
      ? Math.max(0, refAudio.duration - 0.02)
      : Number.POSITIVE_INFINITY
  );
  const finalTime = finalPosition.time;
  session.currentTime = finalTime;
  setTrackMediaTime(trackNum, finalTime);

  if (session.wasPlaying && track.isPlaying) {
    const handoffSeconds = Math.max(0.08, Math.min(0.14, fadeSeconds || 0.1));
    const primedPlaybackReady =
      session.handoffPrimed &&
      session.stems.every(({ stem }) => !stem.audio.paused);
    if (primedPlaybackReady) {
      session.stems.forEach(({ stem }) => {
        fadeTrackAudioIn(trackNum, stem.audio, handoffSeconds * 1000);
      });
      stopTrackScratchSources(session, handoffSeconds);
      handleTrackProgress(trackNum, true);
      return;
    }

    const handoffStartedAt = performance.now();
    const normalVelocity = Math.max(0.05, Number(track.speedVal) || 1);
    const resumeTasks = session.stems.map(({ stem }) => {
      const audio = stem.audio;
      audio.volume = 0;
      audio.currentTime = finalTime;
      audio.preservesPitch = false;
      audio.playbackRate = track.speedVal;
      return audio.play()
        .then(() => ({ audio, started: true }))
        .catch(() => {
          audio.volume = 1;
          return { audio, started: false };
        });
    });

    Promise.all(resumeTasks).then(results => {
      const replacementSession = trackScratchSessions.get(trackNum);
      if (
        replacementSession ||
        !session.wasPlaying ||
        !tracks[trackNum].isPlaying
      ) {
        results.forEach(({ audio, started }) => {
          if (started) audio.pause();
          audio.volume = 1;
        });
        stopTrackScratchSources(session, 0.025);
        return;
      }

      const handoffElapsedSeconds = Math.max(
        0,
        (performance.now() - handoffStartedAt) / 1000
      );
      const handoffMaxTime =
        refAudio && Number.isFinite(refAudio.duration)
          ? Math.max(0, refAudio.duration - 0.02)
          : Number.POSITIVE_INFINITY;
      const synchronizedPosition = resolveTrackTimeWithinActiveLoop(
        trackNum,
        finalTime + normalVelocity * handoffElapsedSeconds,
        handoffMaxTime
      );
      session.currentTime = synchronizedPosition.time;
      setTrackMediaTime(trackNum, synchronizedPosition.time);

      results.forEach(({ audio, started }) => {
        if (started) {
          fadeTrackAudioIn(trackNum, audio, handoffSeconds * 1000);
        }
      });
      stopTrackScratchSources(session, handoffSeconds);
    });
  } else {
    session.stems.forEach(({ stem }) => {
      stem.audio.pause();
      stem.audio.volume = 1;
    });
    stopTrackScratchSources(session, fadeSeconds);
  }

  handleTrackProgress(trackNum, true);
}

function runTrackScratchInertia(session) {
  if (
    !session ||
    trackScratchSessions.get(session.trackNum) !== session ||
    !session.coasting
  ) {
    return;
  }

  const now = performance.now();
  const deltaTime = Math.max(
    0.001,
    Math.min(0.05, (now - session.lastPhysicsAt) / 1000)
  );
  session.lastPhysicsAt = now;

  const track = tracks[session.trackNum];
  const refAudio = session.stems[0]?.stem.audio;
  if (!track || !refAudio) {
    completeTrackScratch(session);
    return;
  }

  const normalVelocity =
    session.wasPlaying && track.isPlaying
      ? Math.max(0.05, Number(track.speedVal) || 1)
      : 0;
  const inertiaDuration = Math.max(0, jogInertiaSeconds);
  if (inertiaDuration <= 0) {
    session.velocity = normalVelocity;
    completeTrackScratch(session, { fadeSeconds: 0.05 });
    return;
  }

  const coastProgress = Math.min(
    1,
    Math.max(0, (now - session.coastStartedAt) / (inertiaDuration * 1000))
  );
  const easedProgress = 1 - Math.pow(1 - coastProgress, 3);
  session.velocity =
    session.coastStartVelocity +
    (normalVelocity - session.coastStartVelocity) * easedProgress;

  const maxTime = Number.isFinite(refAudio.duration)
    ? Math.max(0, refAudio.duration - 0.02)
    : Number.POSITIVE_INFINITY;
  const nextPosition = resolveTrackTimeWithinActiveLoop(
    session.trackNum,
    session.currentTime + session.velocity * deltaTime,
    maxTime
  );
  session.currentTime = nextPosition.time;

  if (!session.handoffPrimed) {
    setTrackMediaTime(session.trackNum, session.currentTime);
  }
  handleTrackProgress(session.trackNum, true);
  if (session.wasPlaying && track.isPlaying) {
    if (nextPosition.wrapped) {
      stopTrackScratchSources(session, 0.008);
    }
    startTrackScratchSources(session, session.velocity);
  }

  const inertiaRemainingSeconds =
    inertiaDuration * Math.max(0, 1 - coastProgress);
  if (inertiaRemainingSeconds <= 0.22) {
    primeTrackScratchHandoff(session, {
      remainingSeconds: inertiaRemainingSeconds,
      normalVelocity
    });
  }

  const settled = coastProgress >= 1;
  const reachedStart = session.currentTime <= 0 && session.velocity < 0;
  const reachedEnd =
    Number.isFinite(maxTime) &&
    session.currentTime >= maxTime &&
    session.velocity > 0;

  if (settled || reachedEnd || (reachedStart && normalVelocity === 0)) {
    session.velocity = normalVelocity;
    completeTrackScratch(session, { fadeSeconds: 0.09 });
    return;
  }

  session.physicsFrame = requestAnimationFrame(() => {
    runTrackScratchInertia(session);
  });
}

function endTrackScratch(
  trackNum,
  { fadeSeconds = 0.1, allowInertia = true } = {}
) {
  const session = trackScratchSessions.get(trackNum);
  if (!session) return;
  clearTimeout(session.sourceIdleTimer);
  clearTimeout(session.autoReleaseTimer);
  if (session.wasPlaying && session.sources.length > 0 && audioCtx) {
    session.currentTime = updateTrackScratchSourceClock(
      session,
      audioCtx.currentTime
    );
    setTrackMediaTime(trackNum, session.currentTime);
  }
  const track = tracks[trackNum];
  const normalVelocity =
    session.wasPlaying && track.isPlaying
      ? Math.max(0.05, Number(track.speedVal) || 1)
      : 0;

  if (
    allowInertia &&
    jogInertiaSeconds > 0 &&
    !session.coasting &&
    Math.abs(session.velocity - normalVelocity) >= 0.025
  ) {
    session.explicitHold = false;
    session.coasting = true;
    const coastStartedAt = performance.now();
    session.lastPhysicsAt = coastStartedAt;
    session.coastStartedAt = coastStartedAt;
    session.coastStartVelocity = session.velocity;
    session.physicsFrame = requestAnimationFrame(() => {
      runTrackScratchInertia(session);
    });
    return;
  }

  if (session.coasting && allowInertia) return;
  completeTrackScratch(session, { fadeSeconds });
}

function jogTrackBySeconds(trackNum, timeDelta) {
  const refAudio = getRefAudio(trackNum);
  if (
    !refAudio ||
    !Number.isFinite(refAudio.currentTime) ||
    !Number.isFinite(timeDelta) ||
    timeDelta === 0
  ) {
    return;
  }

  const duration =
    Number.isFinite(refAudio.duration) && refAudio.duration > 0
      ? refAudio.duration
      : Number.POSITIVE_INFINITY;
  const nextPosition = resolveTrackTimeWithinActiveLoop(
    trackNum,
    refAudio.currentTime + timeDelta,
    duration
  );

  cancelTrackWaveformReset(trackNum);
  setTrackMediaTime(trackNum, nextPosition.time);
  handleTrackProgress(trackNum, true);
}

function applyMidiControllerMessage(message) {
  for (const [controlId, mapping] of Object.entries(
    midiControllerConfig.mappings
  )) {
    if (!midiMappingMatchesMessage(mapping, message)) continue;
    const definition = MIDI_CONTROL_BY_ID.get(controlId);
    if (!definition) continue;

    if (mapping.kind === 'relative') {
      applyMidiJogControl(definition, mapping, message.value);
      continue;
    }

    if (mapping.kind === 'continuous') {
      applyMidiContinuousControl(definition, mapping, message.value);
      continue;
    }

    const active =
      message.type === 'note'
        ? Boolean(message.active)
        : message.value >= Number(mapping.activeThreshold || 1);
    const wasActive = midiButtonStates.get(controlId) === true;
    midiButtonStates.set(controlId, active);
    if (definition.kind === 'jogTouch') {
      if (active && !wasActive) {
        startTrackScratch(definition.trackNum, { explicitHold: true });
      } else if (!active && wasActive) {
        endTrackScratch(definition.trackNum);
      }
      continue;
    }
    if (active && !wasActive) {
      triggerMidiButtonControl(definition);
    } else if (!active && wasActive) {
      releaseMidiButtonControl(definition);
    }
  }
}

function handleMidiMessage(event) {
  const message = parseMidiMessage(event.data);
  if (!message) return;
  const input = event.currentTarget || event.target;

  if (midiWizard) {
    if (input && input.id === midiWizard.inputId) {
      handleMidiWizardMessage(message);
    }
    return;
  }

  if (midiInputMatchesConfig(input)) {
    applyMidiControllerMessage(message);
  }
}

let tabletControllerConnectedClients = 0;
let tabletControllerInfo = null;

function buildTabletCueState(trackNum, cueIndex) {
  const track = tracks[trackNum];
  const cueTime = track.hotCues[cueIndex];
  const isCue = Number.isFinite(cueTime);
  const sound = track.soundButtons[cueIndex];
  const isSample = Boolean(sound && sound.buffer);
  return {
    enabled: isCue || isSample,
    isCue,
    time: isCue ? cueTime : 0,
    label: isCue
      ? `CUE ${cueIndex + 1}`
      : isSample
        ? String(sound.name || `SAMPLE ${cueIndex + 1}`).toUpperCase()
        : 'EMPTY'
  };
}

function buildTabletControllerState() {
  const analyzerOverlay = document.getElementById('song-analyzer-daemon');
  const analysisInProgress = !initialSongCheckComplete
    || document.body.classList.contains('app-daemon-locked')
    || analyzerOverlay?.classList.contains('show');
  return {
    jogPhysics: {
      maxSpeed: jogMaxSpeed,
      inertiaSeconds: jogInertiaSeconds
    },
    snap: {
      enabled: snapEnabled === true,
      thresholdPct: Math.max(1, Math.min(15, Number(snapThresholdPct) || 5))
    },
    libraryAnalysis: {
      inProgress: analysisInProgress,
      blocking: false,
      total: Number(songAnalyzerUiState.total) || 0,
      completed: Number(songAnalyzerUiState.completed) || 0,
      failed: Number(songAnalyzerUiState.failed) || 0,
      current: String(songAnalyzerUiState.current || '')
    },
    tracks: [1, 2].map(trackNum => {
      const track = tracks[trackNum];
      const refAudio = getRefAudio(trackNum);
      const scratchSession = trackScratchSessions.get(trackNum);
      const titleElement = document.getElementById(`track-name-${trackNum}`);
      return {
        title:
          (titleElement && titleElement.textContent) ||
          track.title ||
          `TRACK ${trackNum} (EMPTY)`,
        bpm: Number(track.bpmVal || 120) * Number(track.speedVal || 1),
        speed: Number(track.speedVal || 1),
        playing: track.isPlaying === true,
        loading: track._playPending === true,
        scratching: Boolean(scratchSession),
        coasting: scratchSession?.coasting === true,
        jogVelocity: scratchSession
          ? Number(scratchSession.velocity) || 0
          : Number(track.speedVal) || 1,
        mediaTime:
          refAudio && Number.isFinite(refAudio.currentTime)
            ? refAudio.currentTime
            : 0,
        duration:
          refAudio && Number.isFinite(refAudio.duration)
            ? refAudio.duration
            : 0,
        controls: {
          filter: Number(document.getElementById(`filter-${trackNum}`)?.value ?? 50),
          echo: Number(document.getElementById(`echo-${trackNum}`)?.value ?? 0),
          reverb: Number(document.getElementById(`reverb-${trackNum}`)?.value ?? 0),
          pan: Number(document.getElementById(`pan-${trackNum}`)?.value ?? 0),
          speed: Math.round(Number(track.speedVal || 1) * 100),
          volume: Number(document.getElementById(`vol-${trackNum}`)?.value ?? 100)
        },
        loop: {
          enabled: track.loopEnabled === true,
          hasIn: Number.isFinite(track.loopStartTime),
          hasOut: Number.isFinite(track.loopEndTime),
          beats: document.getElementById(`loop-display-${trackNum}`)?.textContent
            || String(track.autoLoopBeats || 4)
        },
        coverPath: track.coverArtPath || '',
        hasCover: Boolean(track.coverArtPath),
        cues: Array.from(
          { length: 8 },
          (_, cueIndex) => buildTabletCueState(trackNum, cueIndex)
        )
      };
    })
  };
}

function publishTabletControllerState(force = false) {
  if (!force && tabletControllerConnectedClients < 1) return;
  ipcRenderer.send(
    'tablet-controller:state',
    buildTabletControllerState()
  );
}

function publishTabletSongLibrary() {
  const songElements = Array.from(
    document.querySelectorAll('#songs-list li[data-folder]')
  );
  const playlists = Array.from(
    document.querySelectorAll('#playlist-folder-list [data-playlist]')
  )
    .map(element => element.dataset.playlist || '')
    .filter(Boolean);
  const songs = songElements.map(element => ({
    id: element.dataset.folder || '',
    title: element.dataset.songName || element.dataset.folder || '',
    playlist: element.dataset.playlist || '',
    coverPath: element.dataset.coverPath || '',
    key: element.dataset.key || '',
    bpm: Number.isFinite(Number(element.dataset.bpm))
      ? Number(element.dataset.bpm)
      : null,
    duration: Number.isFinite(Number(element.dataset.duration))
      ? Number(element.dataset.duration)
      : null
  }));
  ipcRenderer.send('tablet-controller:library', { playlists, songs });
}

function loadTabletSelectedSong(payload) {
  const trackNum = Number(payload?.trackNum);
  const songId = typeof payload?.songId === 'string' ? payload.songId : '';
  if ((trackNum !== 1 && trackNum !== 2) || !workingDir || !songId) return;

  let selectedSong = null;
  try {
    selectedSong = discoverSongLibrary().songs.find(
      song => song.relativePath === songId
    );
  } catch (error) {
    logConsole(`Tablet: Unable to read song library (${error.message})`, 'err');
    return;
  }
  if (!selectedSong) {
    logConsole('Tablet: Rejected unavailable song selection', 'err');
    return;
  }

  const libraryRoot = path.resolve(workingDir);
  const selectedPath = path.resolve(libraryRoot, selectedSong.relativePath);
  const relativeCheck = path.relative(libraryRoot, selectedPath);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    logConsole('Tablet: Rejected song outside the working directory', 'err');
    return;
  }

  loadDirectoryStems(trackNum, selectedPath);
  publishTabletControllerState(true);
  logConsole(
    `Tablet: Loaded ${selectedSong.displayName} on Track ${trackNum}`,
    'system'
  );
}

function handleTabletControllerCue(payload) {
  const trackNum = Number(payload.trackNum);
  const cueIndex = Number(payload.cueIndex);
  if (
    (trackNum !== 1 && trackNum !== 2) ||
    !Number.isInteger(cueIndex) ||
    cueIndex < 0 ||
    cueIndex >= 8
  ) {
    return;
  }

  const definition = {
    trackNum,
    soundButtonIndex: cueIndex,
    buttonId: `sound-btn-${trackNum}-${cueIndex}`
  };
  if (payload.pressed === true) {
    triggerMidiButtonControl(definition);
  } else {
    releaseMidiButtonControl(definition);
  }
  publishTabletControllerState(true);
}

function updateTabletControllerClientCount(count) {
  tabletControllerConnectedClients = Math.max(0, Number(count) || 0);
  const webButton = document.getElementById('btn-tablet-controller');
  if (webButton) {
    webButton.classList.toggle(
      'has-clients',
      tabletControllerConnectedClients > 0
    );
  }
  if (tabletControllerConnectedClients > 0) {
    publishTabletControllerState(true);
  }
}

function renderTabletControllerInfo(info) {
  tabletControllerInfo = info;
  const address = document.getElementById('tablet-controller-address');
  const copyButton = document.getElementById('btn-tablet-controller-copy');
  if (!address || !copyButton) return;

  const urls = Array.isArray(info?.urls) ? info.urls : [];
  if (info?.ready && urls.length) {
    address.textContent = urls[0];
    address.classList.remove('tablet-address-empty');
    copyButton.disabled = false;
    copyButton.dataset.url = urls[0];
  } else {
    address.textContent = 'NOT AVAILABLE';
    address.classList.add('tablet-address-empty');
    copyButton.disabled = true;
    delete copyButton.dataset.url;
  }
  updateTabletControllerClientCount(info?.connectedClients || 0);
}

async function openTabletControllerModal() {
  const modal = document.getElementById('tablet-controller-modal');
  if (modal) modal.classList.add('show');
  try {
    let info = await ipcRenderer.invoke('tablet-controller:get-info');
    if (!info.ready) {
      await new Promise(resolve => setTimeout(resolve, 350));
      info = await ipcRenderer.invoke('tablet-controller:get-info');
    }
    renderTabletControllerInfo(info);
  } catch (error) {
    renderTabletControllerInfo({ ready: false, urls: [], connectedClients: 0 });
  }
}

function closeTabletControllerModal() {
  const modal = document.getElementById('tablet-controller-modal');
  if (modal) modal.classList.remove('show');
}

async function copyTabletControllerAddress() {
  const copyButton = document.getElementById('btn-tablet-controller-copy');
  const url = copyButton?.dataset.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
  } catch (error) {
    const temporaryInput = document.createElement('textarea');
    temporaryInput.value = url;
    temporaryInput.style.position = 'fixed';
    temporaryInput.style.opacity = '0';
    document.body.appendChild(temporaryInput);
    temporaryInput.select();
    document.execCommand('copy');
    temporaryInput.remove();
  }
  const previousText = copyButton.textContent;
  copyButton.textContent = 'COPIED';
  setTimeout(() => {
    copyButton.textContent = previousText;
  }, 1000);
}

function setupTabletControllerExtension() {
  const openButton = document.getElementById('btn-tablet-controller');
  const closeButton = document.getElementById('btn-tablet-controller-close');
  const copyButton = document.getElementById('btn-tablet-controller-copy');
  const modal = document.getElementById('tablet-controller-modal');

  if (openButton) {
    openButton.addEventListener('click', openTabletControllerModal);
  }
  if (closeButton) {
    closeButton.addEventListener('click', closeTabletControllerModal);
  }
  if (copyButton) {
    copyButton.addEventListener('click', copyTabletControllerAddress);
  }
  if (modal) {
    modal.addEventListener('mousedown', event => {
      if (event.target === modal) closeTabletControllerModal();
    });
  }
  document.addEventListener('keydown', event => {
    if (
      event.key === 'Escape' &&
      modal &&
      modal.classList.contains('show')
    ) {
      event.preventDefault();
      closeTabletControllerModal();
    }
  });

  ipcRenderer.on('tablet-controller:connections', (event, count) => {
    updateTabletControllerClientCount(count);
  });
  ipcRenderer.on('tablet-controller:input', (event, payload) => {
    if (payload?.type === 'jogStart') {
      startTrackScratch(Number(payload.trackNum), { explicitHold: true });
      publishTabletControllerState(true);
    } else if (payload?.type === 'jogMove' || payload?.type === 'jog') {
      moveTrackScratch(
        Number(payload.trackNum),
        Math.max(-1.5, Math.min(1.5, Number(payload.deltaSeconds) || 0)),
        {
          elapsedSeconds:
            Number.isFinite(Number(payload.elapsedMs)) &&
            Number(payload.elapsedMs) > 0
              ? Number(payload.elapsedMs) / 1000
              : null
        }
      );
      publishTabletControllerState(true);
    } else if (payload?.type === 'jogEnd') {
      endTrackScratch(Number(payload.trackNum));
      publishTabletControllerState(true);
    } else if (payload?.type === 'transport') {
      const trackNum = Number(payload.trackNum);
      if (trackNum !== 1 && trackNum !== 2) return;
      // A transport command always wins over an active jog or its inertia.
      // Cancel it before deciding whether PLAY means play or pause so no
      // scratch source or animation frame can outlive the command.
      endTrackScratch(trackNum, { fadeSeconds: 0, allowInertia: false });
      if (payload.action === 'playPause') {
        togglePlayTrack(trackNum);
      } else if (payload.action === 'stop') {
        stopTrack(trackNum);
      }
      publishTabletControllerState(true);
    } else if (payload?.type === 'control') {
      const trackNum = Number(payload.trackNum);
      const param = payload.param;
      const value = Number(payload.value);
      if ((trackNum !== 1 && trackNum !== 2) || !Number.isFinite(value)) return;
      if (param === 'volume') {
        setVolume(trackNum, value);
      } else if (['filter', 'echo', 'reverb', 'pan', 'speed'].includes(param)) {
        const input = document.getElementById(`${param}-${trackNum}`);
        if (!input) return;
        input.value = String(value);
        input.dispatchEvent(new Event('input'));
      } else {
        return;
      }
      publishTabletControllerState(true);
    } else if (payload?.type === 'loop') {
      const trackNum = Number(payload.trackNum);
      if (trackNum !== 1 && trackNum !== 2) return;
      const actionToButton = {
        in: 'btn-loop-in',
        out: 'btn-loop-out',
        auto: 'btn-auto-loop',
        halve: 'btn-loop-halve',
        double: 'btn-loop-double',
        exit: 'btn-loop-exit'
      };
      const buttonPrefix = actionToButton[payload.action];
      if (!buttonPrefix) return;
      document.getElementById(`${buttonPrefix}-${trackNum}`)?.click();
      publishTabletControllerState(true);
    } else if (payload?.type === 'cue') {
      handleTabletControllerCue(payload);
    } else if (payload?.type === 'loadSong') {
      loadTabletSelectedSong(payload);
    }
  });

  setInterval(() => publishTabletControllerState(), 100);
  publishTabletControllerState(true);
  publishTabletSongLibrary();

  const synchronizeConnectedClients = async (attempt = 0) => {
    try {
      const info = await ipcRenderer.invoke('tablet-controller:get-info');
      if (info?.ready) {
        updateTabletControllerClientCount(info.connectedClients || 0);
        return;
      }
    } catch (error) {}
    if (attempt < 4) {
      setTimeout(() => synchronizeConnectedClients(attempt + 1), 300);
    }
  };
  synchronizeConnectedClients();
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.aac': return 'audio/aac';
    case '.flac': return 'audio/flac';
    case '.m4a': return 'audio/mp4';
    default: return 'audio/mpeg';
  }
}

// Simple real-time granular resampler for independent pitch shifting
class PitchShifterNode {
  constructor(context) {
    this.context = context;
    this.pitch = 1.0;
    
    // ScriptProcessorNode with 4096 buffer size
    this.node = context.createScriptProcessor(4096, 2, 2);
    
    // Use a power-of-two buffer size for fast bitwise masking
    const bufferSize = 131072; // 2^17 (approx 3 seconds of audio at 44.1kHz)
    const mask = bufferSize - 1;
    
    this.ringBufferL = new Float32Array(bufferSize);
    this.ringBufferR = new Float32Array(bufferSize);
    this.writePtr = 0;
    
    // Granular pitch shifting parameters
    this.offset1 = 0.0;
    const delaySize = 2048; // grain window size (approx 46ms)
    const halfDelay = delaySize / 2;
    const safetyOffset = 256; // safe distance from write pointer to avoid reads on dirty samples
    
    // Precompute Hanning window table to avoid calling Math.cos() per sample
    this.windowTable = new Float32Array(delaySize);
    for (let i = 0; i < delaySize; i++) {
      this.windowTable[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / delaySize);
    }
    
    this.process = (e) => {
      const inputL = e.inputBuffer.getChannelData(0);
      const inputR = e.inputBuffer.getChannelData(1);
      const outputL = e.outputBuffer.getChannelData(0);
      const outputR = e.outputBuffer.getChannelData(1);
      const len = inputL.length;
      
      // If pitch is 1.0 (normal), bypass to save CPU and maintain native audio quality
      if (this.pitch === 1.0) {
        outputL.set(inputL);
        outputR.set(inputR);
        // Fill ring buffer to avoid silence gaps when pitch is suddenly changed
        for (let i = 0; i < len; i++) {
          this.ringBufferL[this.writePtr] = inputL[i];
          this.ringBufferR[this.writePtr] = inputR[i];
          this.writePtr = (this.writePtr + 1) & mask;
        }
        return;
      }
      
      const rate = 1.0 - this.pitch;
      
      for (let i = 0; i < len; i++) {
        // Record current input sample to ring buffer
        this.ringBufferL[this.writePtr] = inputL[i];
        this.ringBufferR[this.writePtr] = inputR[i];
        
        // Calculate the second overlapping pointer (180 degrees offset) - avoided % operator
        let offset2 = this.offset1 + halfDelay;
        if (offset2 >= delaySize) {
          offset2 -= delaySize;
        }
        
        // Get integer parts for array lookups
        const offset1Int = Math.floor(this.offset1);
        const offset2Int = Math.floor(offset2);
        
        // Safety clamp to prevent out-of-bounds indexing (e.g. if Math.floor of 2047.9999999999998 yields 2048)
        const idx1 = offset1Int >= delaySize ? delaySize - 1 : (offset1Int < 0 ? 0 : offset1Int);
        const idx2 = offset2Int >= delaySize ? delaySize - 1 : (offset2Int < 0 ? 0 : offset2Int);
        
        // Calculate read index positions using fast bitwise mask
        const readPtr1 = (this.writePtr - idx1 - safetyOffset) & mask;
        const readPtr2 = (this.writePtr - idx2 - safetyOffset) & mask;
        
        const readPtr1Prev = (readPtr1 - 1) & mask;
        const readPtr2Prev = (readPtr2 - 1) & mask;
        
        // Interpolation fractional parts
        const frac1 = this.offset1 - offset1Int;
        const frac2 = offset2 - offset2Int;
        
        // Interpolate samples for Tap 1 (Stereo)
        const sample1L = (1 - frac1) * this.ringBufferL[readPtr1] + frac1 * this.ringBufferL[readPtr1Prev];
        const sample1R = (1 - frac1) * this.ringBufferR[readPtr1] + frac1 * this.ringBufferR[readPtr1Prev];
        
        // Interpolate samples for Tap 2 (Stereo)
        const sample2L = (1 - frac2) * this.ringBufferL[readPtr2] + frac2 * this.ringBufferL[readPtr2Prev];
        const sample2R = (1 - frac2) * this.ringBufferR[readPtr2] + frac2 * this.ringBufferR[readPtr2Prev];
        
        // Fast table lookup for Hanning Window weight
        const w = this.windowTable[idx1];
        
        // Perform clean crossfade
        outputL[i] = w * sample1L + (1.0 - w) * sample2L;
        outputR[i] = w * sample1R + (1.0 - w) * sample2R;
        
        // Advance write pointer using fast mask
        this.writePtr = (this.writePtr + 1) & mask;
        
        // Advance sweep offset
        this.offset1 = this.offset1 + rate;
        if (this.offset1 < 0) {
          this.offset1 += delaySize;
        } else if (this.offset1 >= delaySize) {
          this.offset1 -= delaySize;
        }
      }
    };
    this.node.onaudioprocess = null; // Bypassed and disabled by default on startup
  }
  
  setPitch(pitch) {
    this.pitch = pitch;
  }
}


// Bypasses the PitchShifter node when Pitch is at 0 (default) to run at C++ speeds with 0% JS overhead
function updateAudioGraphConnections(trackNum) {
  const track = tracks[trackNum];
  if (!track.gainNode) return; // not initialized yet
  
  try {
    track.filterHPFNode.disconnect();
  } catch(e) {}
  try {
    track.pitchShifter.node.disconnect();
  } catch(e) {}
  
  // Safe check with threshold and type coercion to prevent floating decimal glitches
  const isPitchActive = (Math.abs(Number(track.pitchVal)) > 0.05);
  
  if (isPitchActive) {
    track.pitchShifter.node.onaudioprocess = track.pitchShifter.process; // Enable processing
    track.filterHPFNode.connect(track.pitchShifter.node);
    track.pitchShifter.node.connect(track.gainNode);
    track.pitchShifter.node.connect(track.echoDelayNode);
  } else {
    track.pitchShifter.node.onaudioprocess = null; // Disable processing to save 100% CPU and run at native C++ speeds
    track.filterHPFNode.connect(track.gainNode);
    track.filterHPFNode.connect(track.echoDelayNode);
  }
}

// Track states supporting:
// - main (main.mp3)
// - vocals (vocals.mp3)
// - inst (dynamic list of any other audio files in the folder)
let masterTrackNum = 1;
const tracks = {
  1: {
    stems: {
      main: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'main.mp3' },
      vocals: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'vocals.mp3' },
      inst: {
        audios: [], // Dynamic array of { audio, source, gainNode, file }
        exists: false
      }
    },
    soundButtons: [
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null }
    ],
    hotCues: Array(8).fill(null),
    cueModes: Array(8).fill('play'),
    sampleModes: Array(8).fill('ontop'),
    activeSampleSources: Array.from({ length: 8 }, () => new Set()),
    activeHoldCueIdx: null,
    // EQ filters (applied on combined mix)
    bassFilter: null,
    lowFilter: null,
    trebFilter: null,
    
    // Bipolar Filter Sweep Nodes
    filterLPFNode: null,
    filterHPFNode: null,
    
    // Master Gain (Volume)
    gainNode: null,
    analyser: null,
    
    // Pan and Reverb Nodes
    panNode: null,
    reverbConvolverNode: null,
    reverbWetNode: null,
    
    // State
    isPlaying: false,
    _playPending: false,
    _playRequestToken: 0,
    _mediaLoadToken: 0,
    _mediaReadyPromise: Promise.resolve({ loadToken: 0, results: [] }),
    isSynth: false,
    synthTimer: null,
    dirPath: '',
    title: 'TRACK 1 (EMPTY)',
    
    // EQ Row 3 state
    pitchVal: 0,   // semitones, -12 to 12
    speedVal: 1.0, // playback speed factor, 0.5 to 2.0
    echoVal: 0,    // echo percentage, 0 to 100
    
    // Row 4 and Filter state
    filterVal: 50,    // 0 to 100 (50 is bypass)
    panVal: 0,        // -100 to 100 (0 is center)
    reverbVal: 0,     // 0 to 100 (wet percentage)
    echoTimeVal: 350, // 100ms to 1000ms delay time
    
    // Metronome and Tempo state
    bpmVal: 120,
    bpmDivVal: '1/1',
    metronomeOn: false,
    metronomeIntervalId: null,
    
    // Web Audio Nodes
    pitchShifter: null,
    echoDelayNode: null,
    echoFeedbackNode: null,
    echoWetNode: null,
    
    // Loop State
    loopEnabled: false,
    loopRepeatEnabled: true,
    loopExitAction: 'continue',
    loopStartTime: null,
    loopEndTime: null,
    autoLoopBeats: 4,
    syncEnabled: false,
    endSyncEnabled: false,
    endSyncSeconds: 30,
    endSyncCueIndex: null,
    endSyncMixEnabled: false,
    endSyncMixSeconds: 5,
    endSyncMixStarted: false,
    endSyncFadeInEnabled: false,
    endSyncFadeOutEnabled: false,
    endSyncFadeSeconds: 5,
    endSyncFadeOutStarted: false,
    endSyncRampStarted: false,
    endSyncStartSpeed: null,
    _endSyncTimer: null,
    _endSyncLastFlashBeat: null,
    silenceStartTime: 0,
    silenceEndTime: null,
    silenceAnalysisReady: false,
    visMode: 'waveform',
    beatOffset: 0,
    quantizeEnabled: false,
    _quantizePendingTimer: null
  },
  2: {
    stems: {
      main: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'main.mp3' },
      vocals: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'vocals.mp3' },
      inst: {
        audios: [], // Dynamic array of { audio, source, gainNode, file }
        exists: false
      }
    },
    soundButtons: [
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null }
    ],
    hotCues: Array(8).fill(null),
    cueModes: Array(8).fill('play'),
    sampleModes: Array(8).fill('ontop'),
    activeSampleSources: Array.from({ length: 8 }, () => new Set()),
    activeHoldCueIdx: null,
    // EQ filters (applied on combined mix)
    bassFilter: null,
    lowFilter: null,
    trebFilter: null,
    
    // Bipolar Filter Sweep Nodes
    filterLPFNode: null,
    filterHPFNode: null,
    
    // Master Gain (Volume)
    gainNode: null,
    analyser: null,
    
    // Pan and Reverb Nodes
    panNode: null,
    reverbConvolverNode: null,
    reverbWetNode: null,
    
    // State
    isPlaying: false,
    _playPending: false,
    _playRequestToken: 0,
    _mediaLoadToken: 0,
    _mediaReadyPromise: Promise.resolve({ loadToken: 0, results: [] }),
    isSynth: false,
    synthTimer: null,
    dirPath: '',
    title: 'TRACK 2 (EMPTY)',
    
    // EQ Row 3 state
    pitchVal: 0,
    speedVal: 1.0,
    echoVal: 0,
    
    // Row 4 and Filter state
    filterVal: 50,
    panVal: 0,
    reverbVal: 0,
    echoTimeVal: 350,
    
    // Metronome and Tempo state
    bpmVal: 120,
    bpmDivVal: '1/1',
    metronomeOn: false,
    metronomeIntervalId: null,
    
    // Web Audio Nodes
    pitchShifter: null,
    echoDelayNode: null,
    echoFeedbackNode: null,
    echoWetNode: null,
    
    // Loop State
    loopEnabled: false,
    loopRepeatEnabled: true,
    loopExitAction: 'continue',
    loopStartTime: null,
    loopEndTime: null,
    autoLoopBeats: 4,
    syncEnabled: false,
    endSyncEnabled: false,
    endSyncSeconds: 30,
    endSyncCueIndex: null,
    endSyncMixEnabled: false,
    endSyncMixSeconds: 5,
    endSyncMixStarted: false,
    endSyncFadeInEnabled: false,
    endSyncFadeOutEnabled: false,
    endSyncFadeSeconds: 5,
    endSyncFadeOutStarted: false,
    endSyncRampStarted: false,
    endSyncStartSpeed: null,
    _endSyncTimer: null,
    _endSyncLastFlashBeat: null,
    silenceStartTime: 0,
    silenceEndTime: null,
    silenceAnalysisReady: false,
    visMode: 'waveform',
    beatOffset: 0,
    quantizeEnabled: false,
    _quantizePendingTimer: null
  }
};

const MACRO_COUNT = 8;
const MACRO_KNOB_LABELS = Object.freeze({
  bass: 'BASS',
  low: 'LOWS',
  treb: 'TREBLE',
  inst: 'INST VOLUME',
  voc: 'VOCALS VOLUME',
  pitch: 'PITCH',
  speed: 'SPEED',
  echo: 'ECHO',
  filter: 'FILTER',
  pan: 'PAN',
  reverb: 'REVERB',
  echotime: 'ECHO TIME'
});
const macroTransitions = new Map();
let macroConfigTrackNum = null;
let macroConfigIndex = null;
let macroConfigDraft = null;

function createDefaultMacro(index) {
  return {
    name: `MACRO ${index + 1}`,
    transitionSeconds: 0,
    locked: false,
    assignments: []
  };
}

const trackMacros = {
  1: Array.from({ length: MACRO_COUNT }, (_, index) => createDefaultMacro(index)),
  2: Array.from({ length: MACRO_COUNT }, (_, index) => createDefaultMacro(index))
};

function cloneMacro(macro, index) {
  const transitionSeconds = Number(macro?.transitionSeconds);
  const assignments = Array.isArray(macro?.assignments)
    ? macro.assignments
        .filter(assignment =>
          assignment &&
          typeof assignment.id === 'string' &&
          ['continuous', 'discrete', 'button'].includes(assignment.kind)
        )
        .map(assignment => ({
          id: assignment.id,
          kind: assignment.kind,
          label:
            typeof assignment.label === 'string'
              ? assignment.label.slice(0, 48)
              : assignment.id,
          ...(assignment.kind === 'button'
            ? {}
            : { value: assignment.kind === 'continuous'
                ? Number(assignment.value)
                : String(assignment.value ?? '') })
        }))
        .filter(assignment =>
          assignment.kind !== 'continuous' || Number.isFinite(assignment.value)
        )
    : [];

  return {
    name:
      typeof macro?.name === 'string' && macro.name.trim()
        ? macro.name.trim().slice(0, 24)
        : `MACRO ${index + 1}`,
    transitionSeconds: Number.isFinite(transitionSeconds)
      ? Math.max(0, Math.min(600, transitionSeconds))
      : 0,
    locked: Boolean(macro?.locked),
    assignments
  };
}

function loadLockedMacros() {
  try {
    const saved = JSON.parse(
      localStorage.getItem('notoMixer_lockedMacros') || '{}'
    );
    [1, 2].forEach(trackNum => {
      const savedMacros = saved?.tracks?.[trackNum];
      if (!Array.isArray(savedMacros)) return;
      savedMacros.forEach(savedMacro => {
        const index = Number(savedMacro?.index);
        if (!Number.isInteger(index) || index < 0 || index >= MACRO_COUNT) return;
        const restoredMacro = cloneMacro(savedMacro, index);
        restoredMacro.locked = true;
        trackMacros[trackNum][index] = restoredMacro;
      });
    });
  } catch (error) {
    console.warn('Unable to restore locked macros.', error);
  }
}

function persistLockedMacros() {
  const payload = {
    version: 1,
    tracks: {
      1: trackMacros[1]
        .map((macro, index) => ({ ...macro, index }))
        .filter(macro => macro.locked),
      2: trackMacros[2]
        .map((macro, index) => ({ ...macro, index }))
        .filter(macro => macro.locked)
    }
  };
  localStorage.setItem('notoMixer_lockedMacros', JSON.stringify(payload));
  persistUserSettings();
}

function getMacroButtonLabel(button, trackNum) {
  const id = button.id || '';
  const fixedLabels = {
    [`btn-play-${trackNum}`]: 'PLAY',
    [`btn-stop-${trackNum}`]: 'STOP',
    [`btn-auto-loop-${trackNum}`]: 'AUTO LOOP',
    [`btn-loop-halve-${trackNum}`]: 'LOOP HALF',
    [`btn-loop-double-${trackNum}`]: 'LOOP DOUBLE',
    [`btn-loop-in-${trackNum}`]: 'LOOP IN',
    [`btn-loop-out-${trackNum}`]: 'LOOP OUT',
    [`btn-loop-exit-${trackNum}`]: 'LOOP EXIT',
    [`btn-sync-${trackNum}`]: 'SYNC',
    [`btn-end-sync-${trackNum}`]: 'END SYNC',
    [`btn-quantize-${trackNum}`]: 'QUANTIZE',
    [`btn-tap-${trackNum}`]: 'TAP',
    [`btn-metro-${trackNum}`]: 'METRONOME'
  };
  if (fixedLabels[id]) return fixedLabels[id];
  const soundMatch = id.match(/^sound-btn-[12]-(\d+)$/);
  if (soundMatch) return `BUTTON ${Number(soundMatch[1]) + 1}`;
  return (button.textContent || id || 'BUTTON').trim().replace(/\s+/g, ' ').slice(0, 48);
}

function resolveMacroAssignableControl(target) {
  const trackElement = target.closest?.('.track-strip[data-track]');
  const trackNum = Number(trackElement?.dataset.track);
  if (![1, 2].includes(trackNum)) return null;

  const macroButton = target.closest('.macro-btn');
  if (macroButton) return null;

  const knobWrapper = target.closest('.exertia-knob-wrapper');
  const knobMatch = knobWrapper?.id.match(/^knob-(.+)-([12])-wrapper$/);
  if (knobMatch && Number(knobMatch[2]) === trackNum) {
    const param = knobMatch[1];
    return {
      trackNum,
      id: `knob:${param}`,
      kind: 'continuous',
      label: MACRO_KNOB_LABELS[param] || param.toUpperCase()
    };
  }

  if (
    target.closest('.vol-control-section') ||
    target.closest(`#vol-${trackNum}`)
  ) {
    return {
      trackNum,
      id: 'volume',
      kind: 'continuous',
      label: 'TRACK VOLUME'
    };
  }

  if (
    target.closest('.bpm-control-section') ||
    target.closest(`#bpm-${trackNum}`)
  ) {
    return {
      trackNum,
      id: 'bpm',
      kind: 'continuous',
      label: 'BPM'
    };
  }

  if (
    target.closest('.bpm-div-section') ||
    target.closest(`#bpmdiv-${trackNum}`)
  ) {
    return {
      trackNum,
      id: 'bpm-division',
      kind: 'discrete',
      label: 'BEAT DIVISION'
    };
  }

  const button = target.closest('button');
  if (
    !button ||
    !button.id ||
    button.classList.contains('track-tab-btn') ||
    button.classList.contains('visualizer-mode-btn')
  ) {
    return null;
  }

  return {
    trackNum,
    id: `button:${button.id}`,
    kind: 'button',
    label: getMacroButtonLabel(button, trackNum),
    buttonId: button.id
  };
}

function readMacroControlValue(trackNum, controlId) {
  if (controlId.startsWith('knob:')) {
    const param = controlId.slice('knob:'.length);
    return Number(document.getElementById(`${param}-${trackNum}`)?.value);
  }
  if (controlId === 'volume') {
    return Number(document.getElementById(`vol-${trackNum}`)?.value);
  }
  if (controlId === 'bpm') {
    return Number(document.getElementById(`bpm-${trackNum}`)?.value);
  }
  if (controlId === 'bpm-division') {
    return document.getElementById(`bpmdiv-${trackNum}`)?.value || '1/1';
  }
  return null;
}

function assignControlToMacro(descriptor, macroIndex) {
  const macro = trackMacros[descriptor.trackNum][macroIndex];
  const assignment = {
    id: descriptor.id,
    kind: descriptor.kind,
    label: descriptor.label
  };
  if (descriptor.kind !== 'button') {
    assignment.value = readMacroControlValue(
      descriptor.trackNum,
      descriptor.id
    );
  }

  macro.assignments = macro.assignments.filter(
    existing => existing.id !== assignment.id
  );
  macro.assignments.push(assignment);
  renderMacroButton(descriptor.trackNum, macroIndex);
  if (macro.locked) persistLockedMacros();
  logConsole(
    `Macro: Assigned ${assignment.label} to Track ${descriptor.trackNum} ${macro.name}`,
    'system'
  );
}

function applyMacroContinuousValue(trackNum, assignment, value, isFinal = false) {
  if (assignment.id.startsWith('knob:')) {
    const param = assignment.id.slice('knob:'.length);
    if (['bass', 'low', 'treb'].includes(param)) {
      setEQ(trackNum, param, value);
    } else if (param === 'inst') {
      setStemVolume(trackNum, 'inst', value);
    } else if (param === 'voc') {
      setStemVolume(trackNum, 'vocals', value);
    } else if (param === 'pitch') {
      setPitch(trackNum, value);
    } else if (param === 'speed') {
      setSpeed(trackNum, value, {
        skipMetronomeRestart: !isFinal,
        suppressSyncPropagation: true
      });
    } else if (param === 'echo') {
      setEcho(trackNum, value);
    } else if (param === 'filter') {
      setFilter(trackNum, value);
    } else if (param === 'pan') {
      setPan(trackNum, value);
    } else if (param === 'reverb') {
      setReverb(trackNum, value);
    } else if (param === 'echotime') {
      setEchoTime(trackNum, value);
    }
  } else if (assignment.id === 'volume') {
    setVolume(trackNum, value);
  } else if (assignment.id === 'bpm') {
    setBPM(trackNum, value);
  }
}

function cancelMacroControlTransition(trackNum, controlId) {
  const key = `${trackNum}:${controlId}`;
  const frameId = macroTransitions.get(key);
  if (frameId !== undefined) {
    cancelAnimationFrame(frameId);
    macroTransitions.delete(key);
  }
}

function transitionMacroControl(trackNum, assignment, seconds) {
  const startValue = Number(readMacroControlValue(trackNum, assignment.id));
  const targetValue = Number(assignment.value);
  if (!Number.isFinite(startValue) || !Number.isFinite(targetValue)) return;

  cancelMacroControlTransition(trackNum, assignment.id);
  if (seconds <= 0 || Math.abs(startValue - targetValue) < 0.0001) {
    applyMacroContinuousValue(trackNum, assignment, targetValue, true);
    return;
  }

  const transitionKey = `${trackNum}:${assignment.id}`;
  const startedAt = performance.now();
  const durationMs = seconds * 1000;

  const animate = now => {
    const linearProgress = Math.min(1, (now - startedAt) / durationMs);
    const easedProgress =
      linearProgress * linearProgress * (3 - 2 * linearProgress);
    const value = startValue + (targetValue - startValue) * easedProgress;
    applyMacroContinuousValue(
      trackNum,
      assignment,
      value,
      linearProgress >= 1
    );

    if (linearProgress < 1) {
      macroTransitions.set(transitionKey, requestAnimationFrame(animate));
    } else {
      macroTransitions.delete(transitionKey);
    }
  };

  macroTransitions.set(transitionKey, requestAnimationFrame(animate));
}

function executeMacro(trackNum, macroIndex) {
  const macro = trackMacros[trackNum][macroIndex];
  if (!macro || macro.assignments.length === 0) {
    logConsole(`Macro: ${macro?.name || `Macro ${macroIndex + 1}`} is empty`, 'system');
    return;
  }

  macro.assignments.forEach(assignment => {
    if (assignment.kind === 'button') {
      const buttonId = assignment.id.slice('button:'.length);
      document.getElementById(buttonId)?.click();
    } else if (assignment.kind === 'discrete') {
      if (assignment.id === 'bpm-division') {
        setBPMDiv(trackNum, assignment.value);
      }
    } else {
      transitionMacroControl(
        trackNum,
        assignment,
        macro.transitionSeconds
      );
    }
  });

  const macroButton = document.getElementById(
    `macro-btn-${trackNum}-${macroIndex}`
  );
  if (macroButton) {
    macroButton.classList.add('executing');
    setTimeout(
      () => macroButton.classList.remove('executing'),
      Math.max(180, Math.min(800, macro.transitionSeconds * 1000))
    );
  }
  logConsole(
    `Macro: Executed ${macro.name} on Track ${trackNum} (${macro.assignments.length} controls)`,
    'system'
  );
}

function renderMacroButton(trackNum, macroIndex) {
  const macro = trackMacros[trackNum][macroIndex];
  const button = document.getElementById(
    `macro-btn-${trackNum}-${macroIndex}`
  );
  if (!button) return;
  const name = button.querySelector('.macro-btn-name');
  const meta = button.querySelector('.macro-btn-meta');
  if (name) name.textContent = macro.name;
  if (meta) {
    meta.textContent = macro.assignments.length === 1
      ? '1 CONTROL'
      : `${macro.assignments.length} CONTROLS`;
  }
  button.classList.toggle('assigned', macro.assignments.length > 0);
  button.classList.toggle('locked', macro.locked);
  button.title =
    `${macro.name} · ${macro.assignments.length} assigned · ` +
    `${macro.transitionSeconds}s transition · right-click to configure`;
}

function renderMacroGrid(trackNum) {
  const grid = document.getElementById(`track-content-macros-${trackNum}`);
  if (!grid) return;
  grid.replaceChildren();

  for (let macroIndex = 0; macroIndex < MACRO_COUNT; macroIndex++) {
    const cell = document.createElement('div');
    cell.className = 'macro-btn-cell';

    const number = document.createElement('span');
    number.className = 'macro-btn-num';
    number.textContent = String(macroIndex + 1);

    const button = document.createElement('button');
    button.className = 'macro-btn';
    button.id = `macro-btn-${trackNum}-${macroIndex}`;
    button.type = 'button';
    button.dataset.track = String(trackNum);
    button.dataset.macroIndex = String(macroIndex);

    const name = document.createElement('span');
    name.className = 'macro-btn-name';
    const meta = document.createElement('span');
    meta.className = 'macro-btn-meta';
    button.append(name, meta);
    button.addEventListener('click', () => executeMacro(trackNum, macroIndex));

    cell.append(number, button);
    grid.appendChild(cell);
    renderMacroButton(trackNum, macroIndex);
  }
}

function renderMacroConfigurationAssignments() {
  const list = document.getElementById('macro-config-assignments');
  const count = document.getElementById('macro-config-count');
  if (!list || !count || !macroConfigDraft) return;
  list.replaceChildren();
  count.textContent = String(macroConfigDraft.assignments.length);

  if (macroConfigDraft.assignments.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'macro-assignment-empty';
    empty.textContent = 'NO CONTROLS ASSIGNED';
    list.appendChild(empty);
    return;
  }

  macroConfigDraft.assignments.forEach((assignment, assignmentIndex) => {
    const row = document.createElement('div');
    row.className = 'macro-assignment-row';

    const label = document.createElement('span');
    label.textContent = assignment.label;
    const value = document.createElement('span');
    value.className = 'macro-assignment-value';
    value.textContent = assignment.kind === 'button'
      ? 'TRIGGER'
      : String(assignment.value);
    const remove = document.createElement('button');
    remove.className = 'macro-assignment-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${assignment.label}`;
    remove.addEventListener('click', () => {
      macroConfigDraft.assignments.splice(assignmentIndex, 1);
      renderMacroConfigurationAssignments();
    });

    row.append(label, value, remove);
    list.appendChild(row);
  });
}

function openMacroConfiguration(trackNum, macroIndex) {
  const modal = document.getElementById('macro-config-modal');
  if (!modal) return;
  macroConfigTrackNum = trackNum;
  macroConfigIndex = macroIndex;
  macroConfigDraft = cloneMacro(trackMacros[trackNum][macroIndex], macroIndex);

  const title = document.getElementById('macro-config-title');
  const name = document.getElementById('macro-config-name');
  const transition = document.getElementById('macro-config-transition');
  const lock = document.getElementById('macro-config-lock');
  if (title) title.textContent = `TRACK ${trackNum} · MACRO ${macroIndex + 1}`;
  if (name) name.value = macroConfigDraft.name;
  if (transition) transition.value = String(macroConfigDraft.transitionSeconds);
  if (lock) lock.checked = macroConfigDraft.locked;
  renderMacroConfigurationAssignments();
  modal.classList.add('show');
  setTimeout(() => name?.focus(), 0);
}

function closeMacroConfiguration() {
  document.getElementById('macro-config-modal')?.classList.remove('show');
  macroConfigTrackNum = null;
  macroConfigIndex = null;
  macroConfigDraft = null;
}

function saveMacroConfiguration() {
  if (
    !macroConfigDraft ||
    ![1, 2].includes(macroConfigTrackNum) ||
    !Number.isInteger(macroConfigIndex)
  ) {
    closeMacroConfiguration();
    return;
  }

  const name = document.getElementById('macro-config-name')?.value.trim();
  const transitionValue = Number(
    document.getElementById('macro-config-transition')?.value
  );
  macroConfigDraft.name =
    name?.slice(0, 24) || `MACRO ${macroConfigIndex + 1}`;
  macroConfigDraft.transitionSeconds = Number.isFinite(transitionValue)
    ? Math.max(0, Math.min(600, transitionValue))
    : 0;
  macroConfigDraft.locked = Boolean(
    document.getElementById('macro-config-lock')?.checked
  );

  trackMacros[macroConfigTrackNum][macroConfigIndex] = cloneMacro(
    macroConfigDraft,
    macroConfigIndex
  );
  renderMacroButton(macroConfigTrackNum, macroConfigIndex);
  persistLockedMacros();
  logConsole(
    `Macro: Saved ${trackMacros[macroConfigTrackNum][macroConfigIndex].name} ` +
    `on Track ${macroConfigTrackNum}`,
    'system'
  );
  closeMacroConfiguration();
}

function setHotCueFromMacroMenu(trackNum, buttonIndex) {
  const track = tracks[trackNum];
  const button = document.getElementById(
    `sound-btn-${trackNum}-${buttonIndex}`
  );
  if (!button) return;
  let refAudio = null;
  if (track.stems.main.exists) refAudio = track.stems.main.audio;
  else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
  else if (track.stems.inst.audios.length > 0) {
    refAudio = track.stems.inst.audios[0].audio;
  } else if (track.isSynth && track.fallbackAudio) {
    refAudio = track.fallbackAudio;
  }

  if (!refAudio || !refAudio.duration) {
    logConsole(
      `Err: Cannot set cue, no audio playing on Track ${trackNum}`,
      'err'
    );
    return;
  }

  const cueTime = refAudio.currentTime;
  const hotCueColors = [
    '#ff0055', '#ffaa00', '#ffff00', '#00ff00',
    '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'
  ];
  const cueColor = hotCueColors[buttonIndex % hotCueColors.length];
  stopTrackSampleEffect(trackNum, buttonIndex);
  track.hotCues[buttonIndex] = cueTime;
  track.soundButtons[buttonIndex] = { path: '', name: 'CUE', buffer: null };
  renderHotCueButtonLabel(button, buttonIndex, cueTime);
  button.classList.add('loaded', 'cue-draggable');
  button.draggable = true;
  button.style.color = cueColor;
  button.style.borderColor = cueColor;
  button.title =
    `Cue ${buttonIndex + 1} at ${formatTime(cueTime)} — ` +
    `drag onto the other track's ES button`;
  logConsole(
    `Success: Set Hot Cue ${buttonIndex + 1} at ${cueTime.toFixed(2)}s on Track ${trackNum}`,
    'system'
  );
}

function hideMacroAssignContextMenu() {
  const menu = document.getElementById('macro-assign-context-menu');
  if (!menu) return;
  menu.classList.remove('show', 'open-left');
  menu.setAttribute('aria-hidden', 'true');
}

function addMacroContextAction(menu, label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'macro-context-item';
  button.textContent = label;
  button.addEventListener('click', () => {
    hideMacroAssignContextMenu();
    action();
  });
  menu.appendChild(button);
}

function showMacroAssignContextMenu(event, descriptor) {
  const menu = document.getElementById('macro-assign-context-menu');
  if (!menu) return;
  menu.replaceChildren();

  const title = document.createElement('div');
  title.className = 'macro-context-title';
  title.textContent = `TRACK ${descriptor.trackNum} · ${descriptor.label}`;
  menu.appendChild(title);

  const assignParent = document.createElement('div');
  assignParent.className = 'macro-context-item macro-context-parent';
  assignParent.tabIndex = 0;
  const assignLabel = document.createElement('span');
  assignLabel.textContent = 'ASSIGN TO';
  const arrow = document.createElement('span');
  arrow.textContent = '›';
  const submenu = document.createElement('div');
  submenu.className = 'macro-context-submenu';

  trackMacros[descriptor.trackNum].forEach((macro, macroIndex) => {
    const option = document.createElement('button');
    option.type = 'button';
    const optionName = document.createElement('span');
    optionName.textContent = macro.name;
    const optionCount = document.createElement('small');
    optionCount.textContent = String(macro.assignments.length);
    option.append(optionName, optionCount);
    option.addEventListener('click', submenuEvent => {
      submenuEvent.stopPropagation();
      assignControlToMacro(descriptor, macroIndex);
      hideMacroAssignContextMenu();
    });
    submenu.appendChild(option);
  });
  assignParent.append(assignLabel, arrow, submenu);
  menu.appendChild(assignParent);

  const soundMatch = descriptor.buttonId?.match(/^sound-btn-[12]-(\d+)$/);
  if (soundMatch) {
    const buttonIndex = Number(soundMatch[1]);
    const separator = document.createElement('div');
    separator.className = 'macro-context-separator';
    menu.appendChild(separator);
    const soundData = tracks[descriptor.trackNum].soundButtons[buttonIndex];
    if (
      soundData?.buffer
      && !Number.isFinite(tracks[descriptor.trackNum].hotCues[buttonIndex])
    ) {
      addMacroContextAction(menu, 'EFFECT SETTINGS', () => {
        openSampleSettings({ trackNum: descriptor.trackNum, buttonIndex });
      });
    }
    addMacroContextAction(menu, 'SET HOT CUE', () => {
      setHotCueFromMacroMenu(
        descriptor.trackNum,
        buttonIndex
      );
    });
  }

  if (descriptor.buttonId === `btn-end-sync-${descriptor.trackNum}`) {
    const separator = document.createElement('div');
    separator.className = 'macro-context-separator';
    menu.appendChild(separator);
    addMacroContextAction(menu, 'END SYNC SETTINGS', () => {
      openEndSyncSettings(descriptor.trackNum);
    });
  }

  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - 202))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - 120))}px`;
  menu.classList.toggle('open-left', event.clientX > window.innerWidth - 430);
  menu.classList.add('show');
  menu.setAttribute('aria-hidden', 'false');
}

function setupMacroUI() {
  loadLockedMacros();
  renderMacroGrid(1);
  renderMacroGrid(2);

  document.addEventListener('contextmenu', event => {
    const loopRepeatButton = event.target.closest?.('.btn-loop-repeat');
    if (loopRepeatButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      hideMacroAssignContextMenu();
      const trackMatch = loopRepeatButton.id.match(/^btn-loop-repeat-([12])$/);
      showLoopSettingsContextMenu(
        event,
        trackMatch ? Number(trackMatch[1]) : null
      );
      return;
    }

    const macroButton = event.target.closest?.('.macro-btn');
    if (macroButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      hideMacroAssignContextMenu();
      openMacroConfiguration(
        Number(macroButton.dataset.track),
        Number(macroButton.dataset.macroIndex)
      );
      return;
    }

    const descriptor = resolveMacroAssignableControl(event.target);
    if (!descriptor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showMacroAssignContextMenu(event, descriptor);
  }, true);

  document.addEventListener('mousedown', event => {
    if (!event.target.closest?.('#macro-assign-context-menu')) {
      hideMacroAssignContextMenu();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    hideMacroAssignContextMenu();
    if (
      document.getElementById('macro-config-modal')?.classList.contains('show')
    ) {
      closeMacroConfiguration();
    }
  });
  window.addEventListener('blur', hideMacroAssignContextMenu);
  window.addEventListener('resize', hideMacroAssignContextMenu);

  document.getElementById('macro-config-cancel')
    ?.addEventListener('click', closeMacroConfiguration);
  document.getElementById('macro-config-save')
    ?.addEventListener('click', saveMacroConfiguration);
  document.getElementById('macro-config-clear')
    ?.addEventListener('click', () => {
      if (!macroConfigDraft) return;
      macroConfigDraft.assignments = [];
      renderMacroConfigurationAssignments();
    });
  document.getElementById('macro-config-modal')
    ?.addEventListener('mousedown', event => {
      if (event.target.id === 'macro-config-modal') closeMacroConfiguration();
    });
}

// Web Serial State
let activePort = null;
let handshakeInterval = null;
let syncedParams = {};
let activeWriter = null;
let serialReaderLoop = null;
let esp32Ip = null;
const esp32Port = 41234;

// -------------------------------------------------------------
// Audio & Synth Control Logic
// -------------------------------------------------------------

function createReverbImpulseResponse(duration, decay, sampleRate) {
  const length = sampleRate * duration;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const percent = i / length;
    const envelope = Math.pow(1 - percent, decay);
    left[i] = (Math.random() * 2 - 1) * envelope;
    right[i] = (Math.random() * 2 - 1) * envelope;
  }
  return impulse;
}

function initAudio(trackNum) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Apply saved main audio device if present
    const savedMain = localStorage.getItem('notoMixer_mainAudioDevice');
    if (savedMain && savedMain !== 'default' && typeof audioCtx.setSinkId === 'function') {
      audioCtx.setSinkId(savedMain).catch(err => {
        console.error("Error setting initial main sink ID, falling back to default:", err);
        audioCtx.setSinkId('');
      });
    }
  }
  
  const track = tracks[trackNum];
  if (track.gainNode) return; // Already initialized

  // Common filters for combined mix
  track.bassFilter = audioCtx.createBiquadFilter();
  track.bassFilter.type = 'peaking';
  track.bassFilter.frequency.value = 80;
  track.bassFilter.Q.value = 1.0;
  track.bassFilter.gain.value = 0;

  track.lowFilter = audioCtx.createBiquadFilter();
  track.lowFilter.type = 'peaking';
  track.lowFilter.frequency.value = 320;
  track.lowFilter.Q.value = 1.0;
  track.lowFilter.gain.value = 0;

  track.trebFilter = audioCtx.createBiquadFilter();
  track.trebFilter.type = 'peaking';
  track.trebFilter.frequency.value = 8000;
  track.trebFilter.Q.value = 1.0;
  track.trebFilter.gain.value = 0;

  // Bipolar Filter Sweep Nodes (LPF and HPF)
  track.filterLPFNode = audioCtx.createBiquadFilter();
  track.filterLPFNode.type = 'lowpass';
  track.filterLPFNode.Q.value = 1.0;
  
  track.filterHPFNode = audioCtx.createBiquadFilter();
  track.filterHPFNode.type = 'highpass';
  track.filterHPFNode.Q.value = 1.0;
  
  // Set initial filter frequencies based on filterVal
  const fVal = track.filterVal;
  if (fVal === 50) {
    track.filterLPFNode.frequency.value = 22000;
    track.filterHPFNode.frequency.value = 20;
  } else if (fVal < 50) {
    track.filterLPFNode.frequency.value = 20 * Math.pow(22000 / 20, fVal / 50);
    track.filterHPFNode.frequency.value = 20;
  } else {
    track.filterLPFNode.frequency.value = 22000;
    track.filterHPFNode.frequency.value = 20 * Math.pow(20000 / 20, (fVal - 50) / 50);
  }

  // Master Gain node for volume
  track.gainNode = audioCtx.createGain();
  track.gainNode.gain.value = 0.8; // default 80%

  // Stereo Panner
  track.panNode = audioCtx.createStereoPanner();
  track.panNode.pan.value = track.panVal / 100;

  // Convolution Reverb
  track.reverbConvolverNode = audioCtx.createConvolver();
  track.reverbConvolverNode.buffer = createReverbImpulseResponse(2.0, 2.0, audioCtx.sampleRate);
  
  track.reverbWetNode = audioCtx.createGain();
  track.reverbWetNode.gain.value = (track.reverbVal / 100) * 0.8;

  // Analyser node for visualizer
  track.analyser = audioCtx.createAnalyser();
  track.analyser.fftSize = 256;

  // Create Pitch Shifter
  track.pitchShifter = new PitchShifterNode(audioCtx);
  const pitchFactor = Math.pow(2, track.pitchVal / 12);
  track.pitchShifter.setPitch(pitchFactor);

  // Create Echo Delay chain
  track.echoDelayNode = audioCtx.createDelay(2.0);
  track.echoDelayNode.delayTime.value = track.echoTimeVal / 1000; // delay in seconds
  
  track.echoFeedbackNode = audioCtx.createGain();
  track.echoFeedbackNode.gain.value = (track.echoVal / 100) * 0.75;
  
  track.echoWetNode = audioCtx.createGain();
  track.echoWetNode.gain.value = (track.echoVal / 100) * 0.6;

  // Connect common chain: Bass -> Low -> Treble -> LPF -> HPF
  track.bassFilter.connect(track.lowFilter);
  track.lowFilter.connect(track.trebFilter);
  track.trebFilter.connect(track.filterLPFNode);
  track.filterLPFNode.connect(track.filterHPFNode);
  
  // Feedback loop for echo delay line
  track.echoDelayNode.connect(track.echoFeedbackNode);
  track.echoFeedbackNode.connect(track.echoDelayNode);
  
  // Delay output connects to wet gain node which routes back into fader input (gainNode)
  track.echoDelayNode.connect(track.echoWetNode);
  track.echoWetNode.connect(track.gainNode);
  
  // Dry path: gainNode -> panNode
  track.gainNode.connect(track.panNode);
  
  // Wet Reverb path: gainNode -> reverbConvolverNode -> reverbWetNode -> panNode
  track.gainNode.connect(track.reverbConvolverNode);
  track.reverbConvolverNode.connect(track.reverbWetNode);
  track.reverbWetNode.connect(track.panNode);
  
  // PanNode connects to Analyser, which connects to destination
  track.panNode.connect(track.analyser);
  track.analyser.connect(audioCtx.destination);
  
  // Dynamically configure graph to bypass PitchShifter ScriptProcessor if pitchVal is 0
  updateAudioGraphConnections(trackNum);

  // Initialize static gain nodes for all stems (main, vocals, inst) and connect them to Bass filter
  ['main', 'vocals', 'inst'].forEach(key => {
    const stem = track.stems[key];
    
    if (key !== 'inst') {
      // Append to DOM to prevent Chromium silence routing bug
      if (!stem.audio.parentNode) {
        stem.audio.style.display = 'none';
        document.body.appendChild(stem.audio);
      }
    }

    stem.gainNode = audioCtx.createGain();
    stem.gainNode.gain.value = 1.0; // default 100% volume
    stem.gainNode.connect(track.bassFilter);
  });
}

// -------------------------------------------------------------
// exertia Live UI Knobs and Sliders Calculations
// -------------------------------------------------------------

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians))
  };
}

function drawKnobArc(element, percent) {
  const startAngle = -135;
  const endAngle = -135 + (percent * 270);
  
  if (percent <= 0) {
    element.setAttribute('d', '');
    return;
  }
  
  const start = polarToCartesian(20, 20, 16, startAngle);
  const end = polarToCartesian(20, 20, 16, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  
  const d = [
    "M", start.x, start.y,
    "A", 16, 16, 0, largeArcFlag, 1, end.x, end.y
  ].join(" ");
  
  element.setAttribute('d', d);
}

function updateKnobUI(trackNum, param, val, { syncInput = true } = {}) {
  const knobFill = document.getElementById(`knob-${param}-${trackNum}-fill`);
  const knobPointer = document.getElementById(`knob-${param}-${trackNum}-pointer`);
  const valDisplay = document.getElementById(`val-${param}-${trackNum}`);
  
  if (!knobFill || !knobPointer) return;

  // Sync the hidden range input value so that drag physics start from the correct value
  const input = document.getElementById(`${param}-${trackNum}`);
  if (input && syncInput) {
    input.value = val;
  }

  let percent = 0;
  let formatted = '';

  if (param === 'bass' || param === 'low' || param === 'treb' || param === 'pitch') {
    percent = (val - (-12)) / (12 - (-12));
    if (param === 'pitch') {
      const displayPitch = Math.abs(val) < 0.05 ? 0 : val;
      formatted = `${displayPitch > 0 ? '+' : ''}${displayPitch.toFixed(1)} st`;
    } else {
      formatted = `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;
    }
  } else if (param === 'speed') {
    percent = (val - 50) / (200 - 50);
    formatted = `${Math.round(val)}%`;
  } else if (param === 'filter') {
    percent = val / 100;
    if (val === 50) {
      formatted = 'Byp';
    } else if (val < 50) {
      formatted = `LP ${Math.round((50 - val) * 2)}%`;
    } else {
      formatted = `HP ${Math.round((val - 50) * 2)}%`;
    }
  } else if (param === 'pan') {
    percent = (val - (-100)) / (100 - (-100));
    if (val === 0) {
      formatted = 'C';
    } else if (val < 0) {
      formatted = `L ${Math.abs(val)}`;
    } else {
      formatted = `R ${val}`;
    }
  } else if (param === 'echotime') {
    percent = (val - 100) / (1000 - 100);
    formatted = `${Math.round(val)} ms`;
  } else {
    // inst, voc, echo, reverb
    percent = val / 100;
    formatted = `${Math.round(val)}%`;
  }

  percent = Math.max(0, Math.min(1, percent));
  drawKnobArc(knobFill, percent);

  const angle = -135 + (percent * 270);
  knobPointer.setAttribute('transform', `rotate(${angle} 20 20)`);

  if (valDisplay) {
    valDisplay.textContent = formatted;
  }
}

async function decodeAudioFile(audioContext, filePath) {
  const compatiblePath = await getCompatibleAudioPath(filePath);
  const data = await fs.promises.readFile(compatiblePath);
  const arrayBuffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  );
  return audioContext.decodeAudioData(arrayBuffer);
}

function getVinylPitchSemitones(playbackRate) {
  const safeRate = Math.max(0.01, Number(playbackRate) || 1);
  return 12 * Math.log2(safeRate);
}

function updateTrackPitchUI(trackNum) {
  const track = tracks[trackNum];
  if (!track) return;

  const manualPitch = Number(track.pitchVal) || 0;
  const input = document.getElementById(`pitch-${trackNum}`);
  if (input) input.value = manualPitch;

  const effectivePitch = manualPitch + getVinylPitchSemitones(track.speedVal);
  updateKnobUI(trackNum, 'pitch', effectivePitch, { syncInput: false });
}

function updateVolUI(trackNum, val) {
  const volInput = document.getElementById(`vol-${trackNum}`);
  if (volInput) {
    volInput.value = val;
  }
}

function updateProgressUI(trackNum, val) {
  const fill = document.getElementById(`progress-fill-${trackNum}`);
  if (fill) fill.style.width = `${val}%`;
}

function updateTrackPlatterCover(trackNum, coverPath = '') {
  const platter = document.getElementById(`deck-platter-${trackNum}`);
  const cover = document.getElementById(`deck-platter-cover-${trackNum}`);
  if (!platter || !cover) return;

  const hasCover = Boolean(coverPath && fs.existsSync(coverPath));
  tracks[trackNum].coverArtPath = hasCover ? coverPath : '';
  if (hasCover) {
    cover.src = coverPath;
    cover.alt = `Track ${trackNum} cover art`;
  } else {
    cover.src = DEFAULT_COVER_ART_URI;
    cover.alt = `Track ${trackNum} has no cover art`;
  }
  platter.classList.toggle('has-cover', hasCover);
  platter.classList.toggle('no-cover', !hasCover);
}

function updateTrackPlatterPlayback(trackNum) {
  const platter = document.getElementById(`deck-platter-${trackNum}`);
  if (!platter) return;

  platter.classList.toggle('playing', tracks[trackNum].isPlaying);
}

function updateTrackPlatterPosition(trackNum, mediaTime = null) {
  const disc = document.querySelector(`#deck-platter-${trackNum} .deck-platter-disc`);
  if (!disc) return;
  if (notoMixerConfig.legacyMode) {
    disc.style.transform = 'rotate(0deg)';
    return;
  }

  const refAudio = getRefAudio(trackNum);
  const currentTime = Number.isFinite(mediaTime)
    ? mediaTime
    : (refAudio && Number.isFinite(refAudio.currentTime) ? refAudio.currentTime : 0);
  const degreesPerSecond = 120; // One CDJ-style platter revolution every 3 media seconds.
  const angle = ((Math.max(0, currentTime) * degreesPerSecond) % 360);
  disc.style.transform = `rotate(${angle}deg)`;
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function setTrackMediaTime(trackNum, time) {
  const track = tracks[trackNum];
  const safeTime = Math.max(0, Number(time) || 0);

  if (track.stems.main.exists) track.stems.main.audio.currentTime = safeTime;
  if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = safeTime;
  track.stems.inst.audios.forEach(item => {
    item.audio.currentTime = safeTime;
  });
  updateTrackPlatterPosition(trackNum, safeTime);
}

const LOOP_EXIT_SETTINGS_KEY = 'notoMixer_loopExitActions';

function hideLoopSettingsContextMenu() {
  const menu = document.getElementById('loop-settings-context-menu');
  if (!menu) return;
  menu.classList.remove('show');
  menu.setAttribute('aria-hidden', 'true');
}

function saveLoopExitSettings() {
  localStorage.setItem(LOOP_EXIT_SETTINGS_KEY, JSON.stringify({
    1: tracks[1].loopExitAction,
    2: tracks[2].loopExitAction,
    preview: prevLoopExitAction
  }));
}

function loadLoopExitSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOOP_EXIT_SETTINGS_KEY) || '{}');
    [1, 2].forEach(trackNum => {
      if (saved[trackNum] === 'continue' || saved[trackNum] === 'stop') {
        tracks[trackNum].loopExitAction = saved[trackNum];
      }
    });
    if (saved.preview === 'continue' || saved.preview === 'stop') {
      prevLoopExitAction = saved.preview;
    }
  } catch (error) {
    localStorage.removeItem(LOOP_EXIT_SETTINGS_KEY);
  }
}

function showLoopSettingsContextMenu(event, trackNum = null) {
  const menu = document.getElementById('loop-settings-context-menu');
  if (!menu) return;
  const isPreview = trackNum === null;
  const currentAction = isPreview
    ? prevLoopExitAction
    : tracks[trackNum].loopExitAction;
  menu.replaceChildren();

  const title = document.createElement('div');
  title.className = 'macro-context-title';
  title.textContent = `${isPreview ? 'PREVIEW' : `TRACK ${trackNum}`} · AFTER ONE-SHOT LOOP`;
  menu.appendChild(title);

  [
    { value: 'continue', label: 'CONTINUE PLAYBACK' },
    { value: 'stop', label: 'STOP TRACK' }
  ].forEach(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'macro-context-item';
    button.classList.toggle('selected', option.value === currentAction);
    button.textContent = option.label;
    button.addEventListener('click', () => {
      if (isPreview) {
        prevLoopExitAction = option.value;
      } else {
        tracks[trackNum].loopExitAction = option.value;
      }
      saveLoopExitSettings();
      hideLoopSettingsContextMenu();
    });
    menu.appendChild(button);
  });

  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - 215))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - 90))}px`;
  menu.classList.add('show');
  menu.setAttribute('aria-hidden', 'false');
}

function setupLoopSettingsContextMenu() {
  loadLoopExitSettings();
  document.addEventListener('mousedown', event => {
    if (!event.target.closest?.('#loop-settings-context-menu')) {
      hideLoopSettingsContextMenu();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideLoopSettingsContextMenu();
  });
  window.addEventListener('blur', hideLoopSettingsContextMenu);
  window.addEventListener('resize', hideLoopSettingsContextMenu);
}

function hasValidTrackLoopRange(track) {
  return Boolean(
    track
    && Number.isFinite(track.loopStartTime)
    && Number.isFinite(track.loopEndTime)
    && track.loopEndTime > track.loopStartTime
  );
}

function updateTrackLoopActivationUi(trackNum, active, keepRange = false) {
  const track = tracks[trackNum];
  const autoButton = document.getElementById(`btn-auto-loop-${trackNum}`);
  const inButton = document.getElementById(`btn-loop-in-${trackNum}`);
  const outButton = document.getElementById(`btn-loop-out-${trackNum}`);
  if (autoButton) {
    autoButton.classList.toggle('active', active);
    autoButton.textContent = active ? 'AUTO LOOP ON' : 'AUTO LOOP OFF';
  }
  if (inButton) {
    inButton.classList.toggle('active', active || (keepRange && Number.isFinite(track?.loopStartTime)));
  }
  if (outButton) {
    outButton.classList.toggle('active', active || (keepRange && Number.isFinite(track?.loopEndTime)));
  }
}

function completeTrackOneShotLoop(trackNum) {
  const track = tracks[trackNum];
  if (!track?.loopEnabled || track.loopRepeatEnabled) return;
  track.loopEnabled = false;
  updateTrackLoopActivationUi(trackNum, false, true);
  updateMusicEndingWarning(trackNum);
  if (track.loopExitAction === 'stop') stopTrack(trackNum);
}

function restartTrackLoop(trackNum) {
  const track = tracks[trackNum];
  if (!track || track._playPending || !hasValidTrackLoopRange(track)) return;
  setTrackMediaTime(trackNum, track.loopStartTime);
  track.loopEnabled = true;
  updateTrackLoopActivationUi(trackNum, true);
  updateMusicEndingWarning(trackNum);
  handleTrackProgress(trackNum);
}

function getEffectiveTrackEnd(trackNum, refAudio = getRefAudio(trackNum)) {
  if (!refAudio) return 0;
  const track = tracks[trackNum];
  const fullDuration = Number.isFinite(refAudio.duration) ? refAudio.duration : 0;

  if (skipEndingSilence && track.silenceAnalysisReady
      && Number.isFinite(track.silenceEndTime) && track.silenceEndTime > 0) {
    return Math.min(fullDuration, track.silenceEndTime);
  }

  return fullDuration;
}

function updateMusicEndingWarning(trackNum) {
  const track = tracks[trackNum];
  const header = document.querySelector(`#track-${trackNum} .track-header`);
  if (!header) return;

  const refAudio = getRefAudio(trackNum);
  const effectiveEnd = refAudio ? getEffectiveTrackEnd(trackNum, refAudio) : 0;
  const playbackSpeed = Math.max(0.01, track.speedVal || 1);
  const remainingSeconds = refAudio
    ? (effectiveEnd - refAudio.currentTime) / playbackSpeed
    : Infinity;
  const shouldWarn = musicEndingWarning
    && track.isPlaying
    && !track.isSynth
    && !track.loopEnabled
    && effectiveEnd > 0
    && remainingSeconds > 0
    && remainingSeconds <= 30;
  const wasWarning = header.classList.contains('music-ending-warning-pulse');

  if (!shouldWarn) {
    header.classList.remove('music-ending-warning-pulse');
    header.style.removeProperty('--music-ending-warning-beat');
    header.style.removeProperty('--music-ending-warning-phase');
    return;
  }

  const effectiveBpm = Math.max(20, (track.bpmVal || 120) * playbackSpeed);
  const beatDuration = Math.max(0.1, Math.min(3, 60 / effectiveBpm));
  const mediaBeatDuration = 60 / Math.max(20, track.bpmVal || 120);
  const gridPosition = refAudio.currentTime - (track.beatOffset || 0);
  const phase = ((gridPosition % mediaBeatDuration) + mediaBeatDuration) % mediaBeatDuration;
  const phaseRatio = phase / mediaBeatDuration;

  header.style.setProperty('--music-ending-warning-beat', `${beatDuration}s`);
  if (!wasWarning) {
    header.style.setProperty('--music-ending-warning-phase', `${-phaseRatio * beatDuration}s`);
  }
  header.classList.add('music-ending-warning-pulse');

  if (!wasWarning) {
    logConsole(`Music: Ending warning active on Track ${trackNum}`, 'system');
  }
}

function skipOpeningSilenceIfNeeded(trackNum, shouldLog = true) {
  const track = tracks[trackNum];
  const refAudio = getRefAudio(trackNum);
  if (!skipOpeningSilence || !track.silenceAnalysisReady || !refAudio) return false;
  if (!Number.isFinite(track.silenceStartTime) || track.silenceStartTime <= 0.05) return false;
  if (refAudio.currentTime > 0.08) return false;

  setTrackMediaTime(trackNum, track.silenceStartTime);
  if (shouldLog) {
    logConsole(
      `Music: Skipped ${track.silenceStartTime.toFixed(2)}s of opening silence on Track ${trackNum}`,
      'system'
    );
  }
  return true;
}

/**
 * Detect the first and last sustained audible blocks across every loaded stem.
 * A relative RMS gate adapts to quiet masters, while consecutive active blocks
 * and a small safety pad avoid clipping isolated attacks or reverb tails.
 */
function detectSilenceBoundaries(audioBuffers) {
  const buffers = audioBuffers.filter(buffer => buffer && buffer.duration > 0);
  if (buffers.length === 0) return { start: 0, end: 0 };

  const blockDuration = 0.02;
  const maxDuration = Math.max(...buffers.map(buffer => buffer.duration));
  const blockCount = Math.max(1, Math.ceil(maxDuration / blockDuration));
  const levels = new Float32Array(blockCount);

  buffers.forEach(buffer => {
    const sampleRate = buffer.sampleRate;
    const stride = Math.max(1, Math.floor(sampleRate / 6000));

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
      const startSample = Math.floor(blockIndex * blockDuration * sampleRate);
      if (startSample >= buffer.length) break;
      const endSample = Math.min(
        buffer.length,
        Math.floor((blockIndex + 1) * blockDuration * sampleRate)
      );

      let blockLevel = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        let sumSquares = 0;
        let sampleCount = 0;
        for (let sample = startSample; sample < endSample; sample += stride) {
          const value = data[sample];
          sumSquares += value * value;
          sampleCount++;
        }
        if (sampleCount > 0) {
          blockLevel = Math.max(blockLevel, Math.sqrt(sumSquares / sampleCount));
        }
      }
      levels[blockIndex] = Math.max(levels[blockIndex], blockLevel);
    }
  });

  const sortedLevels = Array.from(levels).filter(level => level > 0).sort((a, b) => a - b);
  if (sortedLevels.length === 0) return { start: 0, end: maxDuration };

  const referenceLevel = sortedLevels[Math.floor((sortedLevels.length - 1) * 0.9)];
  const threshold = Math.max(0.0008, referenceLevel * 0.015);
  const sustainedBlocks = 4;

  let firstActiveBlock = 0;
  let foundStart = false;
  for (let i = 0; i <= levels.length - sustainedBlocks; i++) {
    let sustained = true;
    for (let j = 0; j < sustainedBlocks; j++) {
      if (levels[i + j] < threshold) {
        sustained = false;
        break;
      }
    }
    if (sustained) {
      firstActiveBlock = i;
      foundStart = true;
      break;
    }
  }

  let lastActiveBlock = levels.length - 1;
  let foundEnd = false;
  for (let i = levels.length - 1; i >= sustainedBlocks - 1; i--) {
    let sustained = true;
    for (let j = 0; j < sustainedBlocks; j++) {
      if (levels[i - j] < threshold) {
        sustained = false;
        break;
      }
    }
    if (sustained) {
      lastActiveBlock = i;
      foundEnd = true;
      break;
    }
  }

  if (!foundStart || !foundEnd || lastActiveBlock < firstActiveBlock) {
    return { start: 0, end: maxDuration };
  }

  const safetyPad = 0.04;
  let start = Math.max(0, firstActiveBlock * blockDuration - safetyPad);
  let end = Math.min(maxDuration, (lastActiveBlock + 1) * blockDuration + safetyPad);

  if (start < 0.075) start = 0;
  if (maxDuration - end < 0.075) end = maxDuration;
  return { start, end };
}

// -------------------------------------------------------------
// Playback Sync and Engine
// -------------------------------------------------------------

function performBeatSync(targetNum) {
  const sourceNum = (targetNum === 1) ? 2 : 1;
  const target = tracks[targetNum];
  const source = tracks[sourceNum];
  
  if (!target.bpmVal || !source.bpmVal) return;
  
  // 1. BPM SYNC
  const sourceCurrentBpm = source.bpmVal * source.speedVal;
  const newSpeedVal = sourceCurrentBpm / target.bpmVal;
  const speedPercentage = newSpeedVal * 100;
  
  setSpeed(targetNum, speedPercentage);
  
  // 2. PHASE SYNC
  if (target.isPlaying && source.isPlaying) {
    let targetAudio = null;
    if (target.stems.main.exists) targetAudio = target.stems.main.audio;
    else if (target.stems.vocals.exists) targetAudio = target.stems.vocals.audio;
    else if (target.stems.inst.audios.length > 0) targetAudio = target.stems.inst.audios[0].audio;
    
    let sourceAudio = null;
    if (source.stems.main.exists) sourceAudio = source.stems.main.audio;
    else if (source.stems.vocals.exists) sourceAudio = source.stems.vocals.audio;
    else if (source.stems.inst.audios.length > 0) sourceAudio = source.stems.inst.audios[0].audio;
    
    if (targetAudio && sourceAudio) {
      const beatDurationSec = 60 / sourceCurrentBpm;
      const sourceTime = sourceAudio.currentTime;
      const targetTime = targetAudio.currentTime;
      
      // Calculate beat offset phase relative to each track's beatGridOffset (beatOffset)
      const sourceGridTime = sourceTime - (source.beatOffset || 0);
      const sourcePhase = sourceGridTime % beatDurationSec;
      
      const targetGridIndex = Math.round((targetTime - (target.beatOffset || 0)) / beatDurationSec);
      let newTargetTime = (targetGridIndex * beatDurationSec + sourcePhase) + (target.beatOffset || 0);
      
      if (newTargetTime < 0) newTargetTime = 0;
      if (newTargetTime > targetAudio.duration) newTargetTime = targetAudio.duration;
      
      if (target.stems.main.exists) target.stems.main.audio.currentTime = newTargetTime;
      if (target.stems.vocals.exists) target.stems.vocals.audio.currentTime = newTargetTime;
      target.stems.inst.audios.forEach(item => item.audio.currentTime = newTargetTime);
      
      logConsole(`Sync: Aligned Track ${targetNum} phase to match Track ${sourceNum}`, 'system');
    }
  }
}

function toggleBeatSync(trackNum) {
  const track = tracks[trackNum];
  const enabling = !track.syncEnabled;

  // Regular SYNC and End Sync are two different tempo owners. Only one can
  // control a deck at a time.
  if (enabling && track.endSyncEnabled) {
    setEndSyncEnabled(trackNum, false);
  }

  track.syncEnabled = enabling;
  
  const btn = document.getElementById(`btn-sync-${trackNum}`);
  if (btn) {
    if (track.syncEnabled) {
      btn.classList.add('active');
      logConsole(`Sync: Enabled on Track ${trackNum}`, 'system');
      performBeatSync(trackNum);
    } else {
      btn.classList.remove('active');
      logConsole(`Sync: Disabled on Track ${trackNum}`, 'system');
      setSpeed(trackNum, 100);
    }
  }
}

function updateEndSyncButton(trackNum) {
  const track = tracks[trackNum];
  const btn = document.getElementById(`btn-end-sync-${trackNum}`);
  if (!btn) return;

  const hasAssignedCue = Number.isInteger(track.endSyncCueIndex);
  const mixDescription = track.endSyncMixEnabled
    ? ` MIX starts the other track ${track.endSyncMixSeconds}s early.`
    : '';
  btn.textContent = hasAssignedCue ? `ES: CUE ${track.endSyncCueIndex + 1}` : 'ES';
  btn.classList.toggle('active', track.endSyncEnabled);
  btn.classList.toggle('ramping', track.endSyncEnabled && track.endSyncRampStarted);
  btn.title = hasAssignedCue
    ? `End Sync: start the other track at Cue ${track.endSyncCueIndex + 1}. ${track.endSyncSeconds}s before end.${mixDescription}`
    : `End Sync: ${track.endSyncSeconds}s before end.${mixDescription} Drag a cue from the other track here.`;
  btn.setAttribute('aria-pressed', track.endSyncEnabled ? 'true' : 'false');
}

function clearEndSyncCueAssignment(trackNum, shouldLog = false) {
  const track = tracks[trackNum];
  if (!Number.isInteger(track.endSyncCueIndex)) return;
  const previousCue = track.endSyncCueIndex;
  track.endSyncCueIndex = null;
  updateEndSyncButton(trackNum);
  if (shouldLog) {
    logConsole(
      `End Sync: Removed Cue ${previousCue + 1} handoff from Track ${trackNum}`,
      'system'
    );
  }
}

function clearEndSyncCueAssignmentsForTarget(targetTrackNum) {
  [1, 2].forEach(sourceTrackNum => {
    const destinationTrackNum = sourceTrackNum === 1 ? 2 : 1;
    if (destinationTrackNum === targetTrackNum) {
      clearEndSyncCueAssignment(sourceTrackNum);
    }
  });
}

function clearEndSyncCueAssignmentsForCue(cueTrackNum, cueIndex) {
  [1, 2].forEach(sourceTrackNum => {
    const destinationTrackNum = sourceTrackNum === 1 ? 2 : 1;
    if (destinationTrackNum === cueTrackNum
        && tracks[sourceTrackNum].endSyncCueIndex === cueIndex) {
      clearEndSyncCueAssignment(sourceTrackNum, true);
    }
  });
}

function renderHotCueButtonLabel(button, cueIndex, cueTime) {
  if (!button || !Number.isFinite(cueTime)) return;
  button.classList.remove('empty-sound-btn');

  const cueName = document.createElement('span');
  cueName.className = 'sound-btn-cue-name';
  cueName.textContent = `CUE ${cueIndex + 1}`;

  const cueTimeline = document.createElement('span');
  cueTimeline.className = 'sound-btn-cue-time';
  cueTimeline.textContent = formatTime(cueTime);

  button.replaceChildren(cueName, cueTimeline);
}

function renderEmptySoundButtonLabel(button) {
  if (!button) return;
  const dropLabel = document.createElement('span');
  dropLabel.className = 'sound-btn-empty-primary';
  dropLabel.textContent = 'DROP FILE';
  const divider = document.createElement('span');
  divider.className = 'sound-btn-empty-divider';
  divider.setAttribute('aria-hidden', 'true');
  const rightClickLabel = document.createElement('span');
  rightClickLabel.className = 'sound-btn-empty-secondary';
  rightClickLabel.textContent = 'RIGHT CLICK';
  button.replaceChildren(dropLabel, divider, rightClickLabel);
  button.classList.add('empty-sound-btn');
}

function initializeEmptySoundButtonLabels() {
  document.querySelectorAll('.sound-btn').forEach(button => {
    if ((button.textContent || '').trim() === 'DROP FILE') {
      renderEmptySoundButtonLabel(button);
    }
  });
}

function stopTrackSampleEffect(trackNum, buttonIndex, { logStop = false } = {}) {
  const track = tracks[trackNum];
  const activeSources = track?.activeSampleSources?.[buttonIndex];
  if (!activeSources) return false;
  const hadActiveSources = activeSources.size > 0;

  activeSources.forEach(sourceNode => {
    try { sourceNode.stop(); } catch (error) {}
    try { sourceNode.disconnect(); } catch (error) {}
  });
  activeSources.clear();
  document.getElementById(`sound-btn-${trackNum}-${buttonIndex}`)
    ?.classList.remove('playing');

  if (hadActiveSources && logStop) {
    logConsole(
      `Effect: Stopped Track ${trackNum} button ${buttonIndex + 1}`,
      'system'
    );
  }
  return hadActiveSources;
}

function playTrackSampleEffect(trackNum, buttonIndex, button) {
  const track = tracks[trackNum];
  const soundData = track?.soundButtons?.[buttonIndex];
  if (!soundData?.buffer) return false;

  initAudio(trackNum);
  if (audioCtx?.state === 'suspended') audioCtx.resume();
  if (track.sampleModes[buttonIndex] === 'restart') {
    stopTrackSampleEffect(trackNum, buttonIndex);
  }

  try {
    const sourceNode = audioCtx.createBufferSource();
    const activeSources = track.activeSampleSources[buttonIndex];
    sourceNode.buffer = soundData.buffer;
    sourceNode.connect(track.bassFilter);
    activeSources.add(sourceNode);
    button.classList.add('playing');
    sourceNode.onended = () => {
      activeSources.delete(sourceNode);
      try { sourceNode.disconnect(); } catch (error) {}
      if (activeSources.size === 0) button.classList.remove('playing');
    };
    sourceNode.start(0);
    return true;
  } catch (playError) {
    logConsole(`Err: Failed to play sample: ${playError.message}`, 'err');
    return false;
  }
}

function clearTrackSampleEffect(trackNum, buttonIndex) {
  const track = tracks[trackNum];
  if (!track) return;
  stopTrackSampleEffect(trackNum, buttonIndex);
  track.hotCues[buttonIndex] = null;
  track.cueModes[buttonIndex] = 'play';
  track.sampleModes[buttonIndex] = 'ontop';
  track.soundButtons[buttonIndex] = { path: '', name: 'DROP FILE', buffer: null };

  const button = document.getElementById(`sound-btn-${trackNum}-${buttonIndex}`);
  if (!button) return;
  renderEmptySoundButtonLabel(button);
  button.classList.remove('loaded', 'cue-draggable', 'playing', 'holding');
  button.draggable = false;
  button.style.color = '';
  button.style.borderColor = '';
  button.title = '';
}

function clearTrackHotCues(trackNum) {
  const track = tracks[trackNum];
  track.hotCues.forEach((cueTime, cueIndex) => {
    if (!Number.isFinite(cueTime)) return;
    clearEndSyncCueAssignmentsForCue(trackNum, cueIndex);
    track.hotCues[cueIndex] = null;
    track.cueModes[cueIndex] = 'play';
    track.soundButtons[cueIndex] = { path: '', name: 'DROP FILE', buffer: null };

    const button = document.getElementById(`sound-btn-${trackNum}-${cueIndex}`);
    if (button) {
      renderEmptySoundButtonLabel(button);
      button.classList.remove('loaded', 'cue-draggable', 'playing', 'holding');
      button.draggable = false;
      button.style.color = '';
      button.style.borderColor = '';
      button.title = '';
    }
  });
}

function assignCueToEndSync(endSyncTrackNum, cueTrackNum, cueIndex) {
  const expectedCueTrackNum = endSyncTrackNum === 1 ? 2 : 1;
  const cueTime = tracks[cueTrackNum] && tracks[cueTrackNum].hotCues[cueIndex];

  if (cueTrackNum !== expectedCueTrackNum) {
    logConsole(
      `End Sync: Cue must come from destination Track ${expectedCueTrackNum}`,
      'err'
    );
    return false;
  }
  if (!Number.isFinite(cueTime)) {
    logConsole(`End Sync: Cue ${cueIndex + 1} is no longer available`, 'err');
    return false;
  }

  tracks[endSyncTrackNum].endSyncCueIndex = cueIndex;
  if (!tracks[endSyncTrackNum].endSyncEnabled) {
    setEndSyncEnabled(endSyncTrackNum, true);
  } else {
    updateEndSyncButton(endSyncTrackNum);
  }
  logConsole(
    `End Sync: Track ${endSyncTrackNum} will start Track ${cueTrackNum} at Cue ${cueIndex + 1}`,
    'system'
  );
  return true;
}

function clearEndSyncTimer(trackNum) {
  const track = tracks[trackNum];
  if (track._endSyncTimer) {
    clearInterval(track._endSyncTimer);
    track._endSyncTimer = null;
  }
}

function clearEndSyncFinalFlash(trackNum) {
  const track = tracks[trackNum];
  track._endSyncLastFlashBeat = null;

  [trackNum, trackNum === 1 ? 2 : 1].forEach(headerTrackNum => {
    const header = document.querySelector(`#track-${headerTrackNum} .track-header`);
    if (!header) return;
    if (header._endSyncBeatFlashOwner === trackNum) {
      if (header._endSyncBeatFlashAnimation) {
        header._endSyncBeatFlashAnimation.cancel();
        delete header._endSyncBeatFlashAnimation;
      }
      delete header._endSyncBeatFlashOwner;
    }
    if (header._endSyncPulseBaselineOwner === trackNum) {
      header.classList.remove('end-sync-incoming-pulse-ready');
      delete header._endSyncPulseBaselineOwner;
    }
  });
}

function flashEndSyncBeat(trackNum, otherNum, beatDuration, includeOutgoingTrack) {
  const targetTrackNums = includeOutgoingTrack ? [trackNum, otherNum] : [otherNum];
  const flashDurationMs = Math.max(100, Math.min(3000, beatDuration * 1000));
  const sharedStartTime = document.timeline ? document.timeline.currentTime : null;

  targetTrackNums.forEach(headerTrackNum => {
    const header = document.querySelector(`#track-${headerTrackNum} .track-header`);
    if (!header || typeof header.animate !== 'function') return;

    if (header._endSyncBeatFlashAnimation) {
      header._endSyncBeatFlashAnimation.cancel();
    }

    const animation = header.animate([
      {
        filter: 'brightness(1.75) saturate(1.45)',
        boxShadow: 'inset 0 0 14px rgba(255, 255, 255, 0.38)',
        offset: 0
      },
      {
        filter: 'brightness(0.8) saturate(0.9)',
        boxShadow: 'inset 0 0 0 rgba(255, 255, 255, 0)',
        offset: 0.3
      },
      {
        filter: 'brightness(0.8) saturate(0.9)',
        boxShadow: 'inset 0 0 0 rgba(255, 255, 255, 0)',
        offset: 1
      }
    ], {
      duration: flashDurationMs,
      easing: 'ease-in-out',
      iterations: 1
    });

    if (Number.isFinite(sharedStartTime)) animation.startTime = sharedStartTime;
    header._endSyncBeatFlashAnimation = animation;
    header._endSyncBeatFlashOwner = trackNum;
    animation.onfinish = () => {
      if (header._endSyncBeatFlashAnimation === animation) {
        delete header._endSyncBeatFlashAnimation;
        delete header._endSyncBeatFlashOwner;
      }
    };
  });
}

function updateEndSyncFinalFlash(trackNum, otherNum, refAudio, effectiveEnd) {
  const track = tracks[trackNum];
  if (notoMixerConfig.legacyMode) {
    clearEndSyncFinalFlash(trackNum);
    return;
  }
  const playbackSpeed = Math.max(0.01, track.speedVal || 1);
  const remainingSeconds = (effectiveEnd - refAudio.currentTime) / playbackSpeed;

  if (!track.endSyncRampStarted || remainingSeconds <= 0 || remainingSeconds > 5) {
    clearEndSyncFinalFlash(trackNum);
    return;
  }

  const incomingHeader = document.querySelector(`#track-${otherNum} .track-header`);
  if (incomingHeader) {
    incomingHeader.classList.add('end-sync-incoming-pulse-ready');
    incomingHeader._endSyncPulseBaselineOwner = trackNum;
  }

  const mediaBeatDuration = 60 / Math.max(20, track.bpmVal || 120);
  const gridPosition = refAudio.currentTime - (track.beatOffset || 0);
  const beatIndex = Math.floor(gridPosition / mediaBeatDuration);
  const phase = ((gridPosition % mediaBeatDuration) + mediaBeatDuration) % mediaBeatDuration;
  const phaseInRealSeconds = phase / playbackSpeed;

  if (track._endSyncLastFlashBeat === null) {
    track._endSyncLastFlashBeat = beatIndex;
    // If the five-second window begins directly on a beat, do not wait for
    // the following beat before displaying the first flash.
    if (phaseInRealSeconds > 0.08) return;
  } else if (beatIndex === track._endSyncLastFlashBeat) {
    return;
  } else {
    track._endSyncLastFlashBeat = beatIndex;
  }

  const beatDuration = mediaBeatDuration / playbackSpeed;
  flashEndSyncBeat(trackNum, otherNum, beatDuration, musicEndingWarning);
}

function resetEndSyncRamp(trackNum, restoreSpeed = true) {
  const track = tracks[trackNum];
  clearEndSyncTimer(trackNum);
  clearEndSyncFinalFlash(trackNum);

  const speedToRestore = track.endSyncStartSpeed;
  track.endSyncRampStarted = false;
  track.endSyncStartSpeed = null;
  updateEndSyncButton(trackNum);

  if (restoreSpeed && speedToRestore !== null && Math.abs(track.speedVal - speedToRestore) > 0.0001) {
    setSpeed(trackNum, speedToRestore * 100, {
      suppressSyncPropagation: true,
      skipMetronomeRestart: true
    });
  }
}

function clearEndSyncMissingTargetAlert(trackNum) {
  [1, 2].forEach(candidateTrackNum => {
    const trackStrip = document.getElementById(`track-${candidateTrackNum}`);
    if (!trackStrip || trackStrip._endSyncMissingTargetOwner !== trackNum) return;
    trackStrip.classList.remove('end-sync-missing-target-pulse');
    trackStrip.style.removeProperty('--end-sync-missing-target-beat');
    trackStrip.style.removeProperty('--end-sync-missing-target-phase');
    trackStrip.removeAttribute('aria-label');
    delete trackStrip._endSyncMissingTargetOwner;
  });
}

function updateEndSyncMissingTargetAlert(trackNum, forceResync = false) {
  const track = tracks[trackNum];
  const otherNum = trackNum === 1 ? 2 : 1;
  const targetTrackStrip = document.getElementById(`track-${otherNum}`);
  const shouldAlert = track.endSyncEnabled && !hasPlayableTrackAudio(otherNum);

  if (!shouldAlert || !targetTrackStrip) {
    clearEndSyncMissingTargetAlert(trackNum);
    return;
  }

  const wasAlerting = targetTrackStrip.classList.contains('end-sync-missing-target-pulse')
    && targetTrackStrip._endSyncMissingTargetOwner === trackNum;
  const playbackSpeed = Math.max(0.01, track.speedVal || 1);
  const effectiveBpm = Math.max(20, (track.bpmVal || 120) * playbackSpeed);
  const beatDuration = Math.max(0.1, Math.min(3, 60 / effectiveBpm));
  const refAudio = getRefAudio(trackNum);
  let phaseRatio = 0;

  if (refAudio) {
    const mediaBeatDuration = 60 / Math.max(20, track.bpmVal || 120);
    const gridPosition = refAudio.currentTime - (track.beatOffset || 0);
    const phase = ((gridPosition % mediaBeatDuration) + mediaBeatDuration) % mediaBeatDuration;
    phaseRatio = phase / mediaBeatDuration;
  }

  targetTrackStrip.style.setProperty('--end-sync-missing-target-beat', `${beatDuration}s`);
  if (!wasAlerting || forceResync) {
    targetTrackStrip.style.setProperty(
      '--end-sync-missing-target-phase',
      `${-phaseRatio * beatDuration}s`
    );
  }
  targetTrackStrip.classList.add('end-sync-missing-target-pulse');
  targetTrackStrip._endSyncMissingTargetOwner = trackNum;
  targetTrackStrip.setAttribute(
    'aria-label',
    `Track ${otherNum} is empty. Load a song for End Sync from Track ${trackNum}.`
  );

  if (!wasAlerting) {
    logConsole(
      `End Sync: Track ${otherNum} is empty; pulsing the destination deck`,
      'err'
    );
  }
}

function setEndSyncEnabled(trackNum, enabled) {
  const track = tracks[trackNum];

  if (!enabled) {
    track.endSyncEnabled = false;
    track.endSyncMixStarted = false;
    cancelEndSyncFadesForOwner(trackNum);
    resetEndSyncRamp(trackNum, true);
    updateEndSyncMissingTargetAlert(trackNum);
    logConsole(`End Sync: Disabled on Track ${trackNum}`, 'system');
    return;
  }

  if (track.syncEnabled) {
    track.syncEnabled = false;
    const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
    if (syncBtn) syncBtn.classList.remove('active');
    logConsole(`Sync: Disabled on Track ${trackNum} so End Sync can control tempo`, 'system');
  }

  track.endSyncEnabled = true;
  track.endSyncMixStarted = false;
  track.endSyncFadeOutStarted = false;
  updateEndSyncButton(trackNum);
  updateEndSyncMissingTargetAlert(trackNum, true);
  logConsole(`End Sync: Armed on Track ${trackNum} for the final ${track.endSyncSeconds}s`, 'system');
  updateEndSync(trackNum);
}

function toggleEndSync(trackNum) {
  setEndSyncEnabled(trackNum, !tracks[trackNum].endSyncEnabled);
}

function startEndSyncTimer(trackNum) {
  const track = tracks[trackNum];
  if (track._endSyncTimer) return;

  track._endSyncTimer = setInterval(() => {
    updateEndSync(trackNum);
  }, 50);
}

function getConfiguredTrackGain(trackNum) {
  const volumeInput = document.getElementById(`vol-${trackNum}`);
  const volumeValue = Number(volumeInput?.value);
  return Math.max(0, Math.min(1, (Number.isFinite(volumeValue) ? volumeValue : 80) / 100));
}

function cancelEndSyncTrackFade(trackNum, restoreGain = true) {
  const track = tracks[trackNum];
  if (track._endSyncFadeTimer) {
    clearTimeout(track._endSyncFadeTimer);
    track._endSyncFadeTimer = null;
  }

  if (track.gainNode && audioCtx) {
    const gainParam = track.gainNode.gain;
    const now = audioCtx.currentTime;
    try {
      gainParam.cancelScheduledValues(now);
      if (restoreGain) {
        gainParam.setValueAtTime(getConfiguredTrackGain(trackNum), now);
      }
    } catch (error) {
      console.warn(`Could not cancel End Sync fade on Track ${trackNum}:`, error);
    }
  }

  track._endSyncFadeRole = null;
  track._endSyncFadeOwner = null;
}

function cancelEndSyncFadesForOwner(ownerTrackNum) {
  [1, 2].forEach(trackNum => {
    if (tracks[trackNum]._endSyncFadeOwner === ownerTrackNum) {
      cancelEndSyncTrackFade(trackNum, true);
    }
  });
  if (tracks[ownerTrackNum].endSyncFadeOutStarted) {
    cancelEndSyncTrackFade(ownerTrackNum, true);
  }
  tracks[ownerTrackNum].endSyncFadeOutStarted = false;
}

function scheduleEndSyncTrackFade(
  trackNum,
  startGain,
  endGain,
  durationSeconds,
  role,
  ownerTrackNum
) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  if (!track.gainNode || !audioCtx) return false;

  cancelEndSyncTrackFade(trackNum, false);
  const gainParam = track.gainNode.gain;
  const now = audioCtx.currentTime;
  const duration = Math.max(0.05, Number(durationSeconds) || 0.05);
  const safeStartGain = Math.max(0, Math.min(1, Number(startGain) || 0));
  const safeEndGain = Math.max(0, Math.min(1, Number(endGain) || 0));

  gainParam.cancelScheduledValues(now);
  gainParam.setValueAtTime(safeStartGain, now);
  gainParam.linearRampToValueAtTime(safeEndGain, now + duration);
  track._endSyncFadeRole = role;
  track._endSyncFadeOwner = ownerTrackNum;
  track._endSyncFadeTimer = setTimeout(() => {
    track._endSyncFadeTimer = null;
    if (track._endSyncFadeRole !== role || track._endSyncFadeOwner !== ownerTrackNum) return;
    gainParam.cancelScheduledValues(audioCtx.currentTime);
    gainParam.setValueAtTime(safeEndGain, audioCtx.currentTime);
    track._endSyncFadeRole = null;
    track._endSyncFadeOwner = null;
  }, duration * 1000);
  return true;
}

function startEndSyncDestination(trackNum, { fadeInSeconds = 0 } = {}) {
  const track = tracks[trackNum];
  const otherNum = trackNum === 1 ? 2 : 1;
  const otherTrack = tracks[otherNum];
  const otherAudio = getRefAudio(otherNum);

  if (!otherAudio || otherTrack.isPlaying) {
    return {
      started: false,
      alreadyPlaying: Boolean(otherTrack.isPlaying),
      otherNum,
      cueIndex: null
    };
  }

  const assignedCueIndex = track.endSyncCueIndex;
  const assignedCueTime = Number.isInteger(assignedCueIndex)
    ? otherTrack.hotCues[assignedCueIndex]
    : null;
  let usedCueIndex = null;

  if (Number.isFinite(assignedCueTime)) {
    setTrackMediaTime(otherNum, assignedCueTime);
    usedCueIndex = assignedCueIndex;
  } else {
    if (Number.isInteger(assignedCueIndex)) {
      clearEndSyncCueAssignment(trackNum, true);
    }
    if (Number.isFinite(otherAudio.duration)
        && otherAudio.currentTime >= otherAudio.duration - 0.05) {
      seekTrack(otherNum, 0);
    }
  }

  if (fadeInSeconds > 0) {
    scheduleEndSyncTrackFade(
      otherNum,
      0,
      getConfiguredTrackGain(otherNum),
      fadeInSeconds,
      'in',
      trackNum
    );
  }
  playTrack(otherNum);
  return {
    started: true,
    alreadyPlaying: false,
    otherNum,
    cueIndex: usedCueIndex
  };
}

function updateEndSync(trackNum) {
  const track = tracks[trackNum];
  updateEndSyncMissingTargetAlert(trackNum);
  if (!track.endSyncEnabled || !track.isPlaying || track.isSynth) {
    clearEndSyncFinalFlash(trackNum);
    return;
  }

  const otherNum = trackNum === 1 ? 2 : 1;
  const otherTrack = tracks[otherNum];
  const refAudio = getRefAudio(trackNum);
  const otherAudio = getRefAudio(otherNum);

  if (!refAudio || !otherAudio || !track.bpmVal || !otherTrack.bpmVal) {
    clearEndSyncFinalFlash(trackNum);
    if (track.endSyncRampStarted) {
      resetEndSyncRamp(trackNum, true);
    }
    return;
  }

  const duration = getEffectiveTrackEnd(trackNum, refAudio);
  if (!Number.isFinite(duration) || duration <= 0) {
    clearEndSyncFinalFlash(trackNum);
    return;
  }

  const triggerTime = Math.max(0, duration - track.endSyncSeconds);
  const currentTime = refAudio.currentTime;
  const playbackSpeed = Math.max(0.01, track.speedVal || 1);
  const remainingSeconds = Math.max(0, (duration - currentTime) / playbackSpeed);

  if (track.endSyncMixEnabled) {
    if (track.endSyncFadeOutEnabled) {
      if (remainingSeconds > track.endSyncFadeSeconds && track.endSyncFadeOutStarted) {
        cancelEndSyncTrackFade(trackNum, true);
        track.endSyncFadeOutStarted = false;
      } else if (!track.endSyncFadeOutStarted
          && remainingSeconds > 0
          && remainingSeconds <= track.endSyncFadeSeconds) {
        const fadeDuration = Math.min(track.endSyncFadeSeconds, remainingSeconds);
        if (scheduleEndSyncTrackFade(
          trackNum,
          track.gainNode ? track.gainNode.gain.value : getConfiguredTrackGain(trackNum),
          0,
          fadeDuration,
          'out',
          trackNum
        )) {
          track.endSyncFadeOutStarted = true;
          logConsole(
            `End Sync MIX: Fading out Track ${trackNum} over ${track.endSyncFadeSeconds}s`,
            'system'
          );
        }
      }
    }

    if (remainingSeconds > track.endSyncMixSeconds
        && track.endSyncMixStarted && !otherTrack.isPlaying) {
      track.endSyncMixStarted = false;
    }

    if (!track.endSyncMixStarted
        && remainingSeconds > 0
        && remainingSeconds <= track.endSyncMixSeconds) {
      const mixResult = startEndSyncDestination(trackNum, {
        fadeInSeconds: track.endSyncFadeInEnabled ? track.endSyncFadeSeconds : 0
      });
      if (mixResult.started) {
        track.endSyncMixStarted = true;
        if (track.endSyncFadeInEnabled) {
          logConsole(
            `End Sync MIX: Fading in Track ${otherNum} over ${track.endSyncFadeSeconds}s`,
            'system'
          );
        }
        logConsole(
          Number.isInteger(mixResult.cueIndex)
            ? `End Sync MIX: Started Track ${otherNum} ${track.endSyncMixSeconds}s early at Cue ${mixResult.cueIndex + 1}`
            : `End Sync MIX: Started Track ${otherNum} ${track.endSyncMixSeconds}s early`,
          'system'
        );
        if (Number.isInteger(mixResult.cueIndex)) {
          clearEndSyncCueAssignment(trackNum);
        }
      }
    }
  }

  // Seeking back out of the ES window cancels the current pass and restores
  // the exact speed that was active when the ramp began.
  if (currentTime < triggerTime) {
    clearEndSyncFinalFlash(trackNum);
    if (track.endSyncRampStarted) {
      resetEndSyncRamp(trackNum, true);
    }
    return;
  }

  if (!track.endSyncRampStarted) {
    track.endSyncRampStarted = true;
    track.endSyncStartSpeed = track.speedVal;
    updateEndSyncButton(trackNum);
    logConsole(
      `End Sync: Track ${trackNum} ramp started (${track.endSyncSeconds}s -> Track ${otherNum})`,
      'system'
    );
  }

  const rampDuration = Math.max(0.001, duration - triggerTime);
  const progress = Math.max(0, Math.min(1, (currentTime - triggerTime) / rampDuration));
  const easedProgress = progress * progress * (3 - (2 * progress)); // smoothstep
  const targetSpeed = (otherTrack.bpmVal * otherTrack.speedVal) / track.bpmVal;
  const nextSpeed = track.endSyncStartSpeed
    + ((targetSpeed - track.endSyncStartSpeed) * easedProgress);

  if (Math.abs(track.speedVal - nextSpeed) > 0.0001) {
    setSpeed(trackNum, nextSpeed * 100, {
      suppressSyncPropagation: true,
      skipMetronomeRestart: true
    });
  }

  updateEndSyncFinalFlash(trackNum, otherNum, refAudio, duration);
  startEndSyncTimer(trackNum);
}

function hasPlayableTrackAudio(trackNum) {
  return Boolean(getRefAudio(trackNum));
}

function cancelTrackWaveformReset(trackNum, returnToStart = false) {
  const track = tracks[trackNum];
  const wasActive = Boolean(
    track._waveformResetActive
    || track._waveformResetDissolveTimer
    || track._waveformResetTimer
    || track._waveformResetFrame
  );
  track._waveformResetToken = (track._waveformResetToken || 0) + 1;
  if (track._waveformResetDissolveTimer) {
    clearTimeout(track._waveformResetDissolveTimer);
    track._waveformResetDissolveTimer = null;
  }
  if (track._waveformResetTimer) {
    clearTimeout(track._waveformResetTimer);
    track._waveformResetTimer = null;
  }
  if (track._waveformResetFrame) {
    cancelAnimationFrame(track._waveformResetFrame);
    track._waveformResetFrame = null;
  }
  track._waveformResetActive = false;
  track._waveformResetGraySettled = false;

  [
    document.getElementById(`overview-canvas-${trackNum}`),
    document.getElementById(`canvas-${trackNum}`)
  ].filter(Boolean).forEach(canvas => canvas.classList.remove('waveform-end-reset'));

  if (returnToStart && wasActive && getRefAudio(trackNum)) {
    setTrackMediaTime(trackNum, 0);
    updateProgressUI(trackNum, 0);
    const currentTimeLabel = document.getElementById(`time-current-${trackNum}`);
    if (currentTimeLabel && document.activeElement !== currentTimeLabel) {
      currentTimeLabel.textContent = '0:00';
    }
  }
}

function animateTrackWaveformReset(trackNum, startTime) {
  const track = tracks[trackNum];
  const refAudio = getRefAudio(trackNum);
  if (!refAudio || !Number.isFinite(startTime) || startTime <= 0) return;

  cancelTrackWaveformReset(trackNum);
  const animationToken = track._waveformResetToken;
  const fullDuration = Number.isFinite(refAudio.duration) && refAudio.duration > 0
    ? refAudio.duration
    : startTime;
  const animationDuration = 900;
  const canvases = [
    document.getElementById(`overview-canvas-${trackNum}`),
    document.getElementById(`canvas-${trackNum}`)
  ].filter(Boolean);

  if (notoMixerConfig.legacyMode) {
    const heldTime = Math.min(startTime, fullDuration);
    track._waveformResetActive = true;
    track._waveformResetGraySettled = true;
    canvases.forEach(canvas => canvas.classList.add('waveform-end-reset'));
    setTrackMediaTime(trackNum, heldTime);
    updateProgressUI(trackNum, (heldTime / fullDuration) * 100);
    const heldTimeLabel = document.getElementById(`time-current-${trackNum}`);
    if (heldTimeLabel && document.activeElement !== heldTimeLabel) {
      heldTimeLabel.textContent = formatTime(heldTime);
    }
    track._waveformResetTimer = setTimeout(() => {
      track._waveformResetTimer = null;
      if (track._waveformResetToken !== animationToken) return;
      setTrackMediaTime(trackNum, 0);
      updateProgressUI(trackNum, 0);
      if (heldTimeLabel && document.activeElement !== heldTimeLabel) {
        heldTimeLabel.textContent = '0:00';
      }
      track._waveformResetActive = false;
      track._waveformResetGraySettled = false;
      canvases.forEach(canvas => canvas.classList.remove('waveform-end-reset'));
    }, 2000);
    return;
  }

  track._waveformResetActive = true;
  track._waveformResetGraySettled = false;
  canvases.forEach(canvas => canvas.classList.add('waveform-end-reset'));
  setTrackMediaTime(trackNum, Math.min(startTime, fullDuration));
  updateProgressUI(trackNum, (Math.min(startTime, fullDuration) / fullDuration) * 100);
  const heldTimeLabel = document.getElementById(`time-current-${trackNum}`);
  if (heldTimeLabel && document.activeElement !== heldTimeLabel) {
    heldTimeLabel.textContent = formatTime(Math.min(startTime, fullDuration));
  }
  track._waveformResetDissolveTimer = setTimeout(() => {
    track._waveformResetDissolveTimer = null;
    if (track._waveformResetToken === animationToken) {
      track._waveformResetGraySettled = true;
    }
  }, 600);

  track._waveformResetTimer = setTimeout(() => {
    track._waveformResetTimer = null;
    const startedAt = performance.now();

    const drawResetFrame = now => {
      if (track._waveformResetToken !== animationToken) return;

      const progress = Math.min(1, (now - startedAt) / animationDuration);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const nextTime = Math.max(0, startTime * (1 - easedProgress));
      setTrackMediaTime(trackNum, nextTime);
      updateProgressUI(trackNum, (nextTime / fullDuration) * 100);

      const currentTimeLabel = document.getElementById(`time-current-${trackNum}`);
      if (currentTimeLabel && document.activeElement !== currentTimeLabel) {
        currentTimeLabel.textContent = formatTime(nextTime);
      }

      if (progress < 1) {
        track._waveformResetFrame = requestAnimationFrame(drawResetFrame);
        return;
      }

      setTrackMediaTime(trackNum, 0);
      updateProgressUI(trackNum, 0);
      if (currentTimeLabel && document.activeElement !== currentTimeLabel) {
        currentTimeLabel.textContent = '0:00';
      }
      track._waveformResetFrame = null;
      track._waveformResetActive = false;
      track._waveformResetGraySettled = false;
      canvases.forEach(canvas => canvas.classList.remove('waveform-end-reset'));
    };

    track._waveformResetFrame = requestAnimationFrame(drawResetFrame);
  }, 2000);
}

function handleTrackEnded(trackNum) {
  const track = tracks[trackNum];
  const otherNum = trackNum === 1 ? 2 : 1;
  const shouldHandoff = track.endSyncEnabled;
  const mixWasStarted = track.endSyncMixStarted;
  const endedAudio = getRefAudio(trackNum);
  const endedAt = endedAudio
    ? Math.max(endedAudio.currentTime || 0, getEffectiveTrackEnd(trackNum, endedAudio))
    : 0;

  stopTrack(trackNum, { preserveOwnedFades: true });
  track.endSyncMixStarted = false;
  animateTrackWaveformReset(trackNum, endedAt);

  if (!shouldHandoff) return;

  if (!hasPlayableTrackAudio(otherNum)) {
    logConsole(`End Sync: Track ${otherNum} is empty; automatic handoff skipped`, 'err');
    return;
  }

  const otherTrack = tracks[otherNum];
  if (otherTrack.isPlaying) {
    logConsole(
      mixWasStarted
        ? `End Sync MIX: Track ${trackNum} ended; Track ${otherNum} continues playing`
        : `End Sync: Track ${otherNum} is already playing`,
      'system'
    );
    if (mixWasStarted && Number.isInteger(track.endSyncCueIndex)) {
      clearEndSyncCueAssignment(trackNum);
    }
    return;
  }

  const assignedCueIndex = track.endSyncCueIndex;
  const handoffResult = startEndSyncDestination(trackNum);
  logConsole(
    Number.isInteger(handoffResult.cueIndex)
      ? `End Sync: Track ${trackNum} ended; started Track ${otherNum} at Cue ${handoffResult.cueIndex + 1}`
      : `End Sync: Track ${trackNum} ended; started Track ${otherNum}`,
    'system'
  );
  if (Number.isInteger(assignedCueIndex)) {
    clearEndSyncCueAssignment(trackNum);
  }
}

let endSyncSettingsTrack = null;

function updateEndSyncSettingsPreview() {
  if (endSyncSettingsTrack === null) return;

  const trackNum = endSyncSettingsTrack;
  const otherNum = trackNum === 1 ? 2 : 1;
  const transitionInput = document.getElementById('end-sync-seconds');
  const mixToggle = document.getElementById('end-sync-mix-enabled');
  const mixInput = document.getElementById('end-sync-mix-seconds');
  const mixValueField = document.querySelector('.end-sync-mix-value');
  const fadeInToggle = document.getElementById('end-sync-fade-in');
  const fadeOutToggle = document.getElementById('end-sync-fade-out');
  const fadeInput = document.getElementById('end-sync-fade-seconds');
  const fadeOptions = document.querySelector('.end-sync-fade-options');
  const fadeValueField = document.querySelector('.end-sync-fade-value');
  const description = document.getElementById('end-sync-description');
  const transitionSeconds = Math.max(1, Math.round(Number(transitionInput?.value) || 30));
  const mixSeconds = Math.max(1, Math.round(Number(mixInput?.value) || 5));
  const fadeSeconds = Math.max(1, Math.round(Number(fadeInput?.value) || 5));
  const mixEnabled = Boolean(mixToggle?.checked);
  const fadeInEnabled = mixEnabled && Boolean(fadeInToggle?.checked);
  const fadeOutEnabled = mixEnabled && Boolean(fadeOutToggle?.checked);
  const fadeEnabled = fadeInEnabled || fadeOutEnabled;

  if (mixInput) mixInput.disabled = !mixEnabled;
  if (fadeInToggle) fadeInToggle.disabled = !mixEnabled;
  if (fadeOutToggle) fadeOutToggle.disabled = !mixEnabled;
  if (fadeInput) fadeInput.disabled = !fadeEnabled;
  if (mixValueField) mixValueField.classList.toggle('disabled', !mixEnabled);
  if (fadeOptions) fadeOptions.classList.toggle('disabled', !mixEnabled);
  if (fadeValueField) fadeValueField.classList.toggle('disabled', !fadeEnabled);
  if (description) {
    if (!mixEnabled) {
      description.textContent =
        `During the final ${transitionSeconds} seconds, Track ${trackNum} eases toward Track ${otherNum}'s tempo. Track ${otherNum} starts when Track ${trackNum} ends.`;
    } else {
      const fadeDescriptions = [];
      if (fadeInEnabled) fadeDescriptions.push(`Track ${otherNum} fades in over ${fadeSeconds}s`);
      if (fadeOutEnabled) fadeDescriptions.push(`Track ${trackNum} fades out over ${fadeSeconds}s`);
      description.textContent =
        `During the final ${transitionSeconds} seconds, Track ${trackNum} eases toward Track ${otherNum}'s tempo. MIX starts Track ${otherNum} ${mixSeconds} seconds before the end.${fadeDescriptions.length ? ` ${fadeDescriptions.join('; ')}.` : ''}`;
    }
  }
}

function openEndSyncSettings(trackNum) {
  endSyncSettingsTrack = trackNum;
  const modal = document.getElementById('end-sync-modal');
  const title = document.getElementById('end-sync-modal-title');
  const input = document.getElementById('end-sync-seconds');
  const mixToggle = document.getElementById('end-sync-mix-enabled');
  const mixInput = document.getElementById('end-sync-mix-seconds');
  const fadeInToggle = document.getElementById('end-sync-fade-in');
  const fadeOutToggle = document.getElementById('end-sync-fade-out');
  const fadeInput = document.getElementById('end-sync-fade-seconds');

  if (!modal || !input) return;

  if (title) title.textContent = `END SYNC — TRACK ${trackNum}`;
  input.value = tracks[trackNum].endSyncSeconds;
  if (mixToggle) mixToggle.checked = tracks[trackNum].endSyncMixEnabled;
  if (mixInput) mixInput.value = tracks[trackNum].endSyncMixSeconds;
  if (fadeInToggle) fadeInToggle.checked = tracks[trackNum].endSyncFadeInEnabled;
  if (fadeOutToggle) fadeOutToggle.checked = tracks[trackNum].endSyncFadeOutEnabled;
  if (fadeInput) fadeInput.value = tracks[trackNum].endSyncFadeSeconds;
  updateEndSyncSettingsPreview();

  modal.classList.add('show');
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeEndSyncSettings() {
  const modal = document.getElementById('end-sync-modal');
  if (modal) modal.classList.remove('show');
  endSyncSettingsTrack = null;
}

function saveEndSyncSettings() {
  if (endSyncSettingsTrack === null) return;

  const trackNum = endSyncSettingsTrack;
  const input = document.getElementById('end-sync-seconds');
  const mixToggle = document.getElementById('end-sync-mix-enabled');
  const mixInput = document.getElementById('end-sync-mix-seconds');
  const fadeInToggle = document.getElementById('end-sync-fade-in');
  const fadeOutToggle = document.getElementById('end-sync-fade-out');
  const fadeInput = document.getElementById('end-sync-fade-seconds');
  let seconds = input ? Math.round(Number(input.value)) : 30;
  let mixSeconds = mixInput ? Math.round(Number(mixInput.value)) : 5;
  let fadeSeconds = fadeInput ? Math.round(Number(fadeInput.value)) : 5;
  if (!Number.isFinite(seconds)) seconds = 30;
  if (!Number.isFinite(mixSeconds)) mixSeconds = 5;
  if (!Number.isFinite(fadeSeconds)) fadeSeconds = 5;
  seconds = Math.max(1, Math.min(600, seconds));
  mixSeconds = Math.max(1, Math.min(600, mixSeconds));
  fadeSeconds = Math.max(1, Math.min(600, fadeSeconds));

  const track = tracks[trackNum];
  cancelEndSyncFadesForOwner(trackNum);
  if (track.endSyncRampStarted) {
    resetEndSyncRamp(trackNum, true);
  }
  track.endSyncSeconds = seconds;
  track.endSyncMixEnabled = Boolean(mixToggle?.checked);
  track.endSyncMixSeconds = mixSeconds;
  track.endSyncMixStarted = false;
  track.endSyncFadeInEnabled = Boolean(fadeInToggle?.checked);
  track.endSyncFadeOutEnabled = Boolean(fadeOutToggle?.checked);
  track.endSyncFadeSeconds = fadeSeconds;
  track.endSyncFadeOutStarted = false;
  localStorage.setItem(`notoMixer_endSyncSeconds_${trackNum}`, String(seconds));
  localStorage.setItem(
    `notoMixer_endSyncMixEnabled_${trackNum}`,
    track.endSyncMixEnabled ? 'true' : 'false'
  );
  localStorage.setItem(`notoMixer_endSyncMixSeconds_${trackNum}`, String(mixSeconds));
  localStorage.setItem(
    `notoMixer_endSyncFadeInEnabled_${trackNum}`,
    track.endSyncFadeInEnabled ? 'true' : 'false'
  );
  localStorage.setItem(
    `notoMixer_endSyncFadeOutEnabled_${trackNum}`,
    track.endSyncFadeOutEnabled ? 'true' : 'false'
  );
  localStorage.setItem(`notoMixer_endSyncFadeSeconds_${trackNum}`, String(fadeSeconds));
  persistUserSettings();
  updateEndSyncButton(trackNum);
  logConsole(
    track.endSyncMixEnabled
      ? `End Sync: Track ${trackNum} transition set to ${seconds}s; MIX starts ${mixSeconds}s early; fades ${fadeSeconds}s`
      : `End Sync: Track ${trackNum} transition set to ${seconds}s; MIX disabled`,
    'system'
  );

  closeEndSyncSettings();
  updateEndSync(trackNum);
}

function setupEndSyncModalListeners() {
  const modal = document.getElementById('end-sync-modal');
  const input = document.getElementById('end-sync-seconds');
  const mixToggle = document.getElementById('end-sync-mix-enabled');
  const mixInput = document.getElementById('end-sync-mix-seconds');
  const fadeInToggle = document.getElementById('end-sync-fade-in');
  const fadeOutToggle = document.getElementById('end-sync-fade-out');
  const fadeInput = document.getElementById('end-sync-fade-seconds');
  const cancelBtn = document.getElementById('end-sync-btn-cancel');
  const saveBtn = document.getElementById('end-sync-btn-save');

  if (cancelBtn) cancelBtn.addEventListener('click', closeEndSyncSettings);
  if (saveBtn) saveBtn.addEventListener('click', saveEndSyncSettings);
  if (input) {
    input.addEventListener('input', updateEndSyncSettingsPreview);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveEndSyncSettings();
    });
  }
  if (mixToggle) mixToggle.addEventListener('change', updateEndSyncSettingsPreview);
  if (mixInput) {
    mixInput.addEventListener('input', updateEndSyncSettingsPreview);
    mixInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveEndSyncSettings();
    });
  }
  if (fadeInToggle) fadeInToggle.addEventListener('change', updateEndSyncSettingsPreview);
  if (fadeOutToggle) fadeOutToggle.addEventListener('change', updateEndSyncSettingsPreview);
  if (fadeInput) {
    fadeInput.addEventListener('input', updateEndSyncSettingsPreview);
    fadeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveEndSyncSettings();
    });
  }
  if (modal) {
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) closeEndSyncSettings();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && modal.classList.contains('show')) {
      closeEndSyncSettings();
    }
  });
}

function syncStems(trackNum) {
  const track = tracks[trackNum];
  if (!track.isPlaying || track.isSynth) return;
  
  // Reference audio is the first loaded active audio element
  let refAudio = null;
  if (track.stems.main.exists) {
    refAudio = track.stems.main.audio;
  } else if (track.stems.vocals.exists) {
    refAudio = track.stems.vocals.audio;
  } else if (track.stems.inst.audios.length > 0) {
    refAudio = track.stems.inst.audios[0].audio;
  }
  
  if (!refAudio) return;
  
  const refTime = refAudio.currentTime;
  
  // Align main
  if (track.stems.main.exists && track.stems.main.audio !== refAudio) {
    if (Math.abs(track.stems.main.audio.currentTime - refTime) > 0.05) {
      track.stems.main.audio.currentTime = refTime;
    }
  }
  // Align vocals
  if (track.stems.vocals.exists && track.stems.vocals.audio !== refAudio) {
    if (Math.abs(track.stems.vocals.audio.currentTime - refTime) > 0.05) {
      track.stems.vocals.audio.currentTime = refTime;
    }
  }
  // Align all instrumental tracks
  track.stems.inst.audios.forEach(item => {
    if (item.audio !== refAudio) {
      if (Math.abs(item.audio.currentTime - refTime) > 0.05) {
        item.audio.currentTime = refTime;
      }
    }
  });
}

function handleTrackProgress(trackNum, forceUpdate = false) {
  const track = tracks[trackNum];
  if ((!track.isPlaying && !forceUpdate) || track.isSynth) return;

  let refAudio = null;
  if (track.stems.main.exists) {
    refAudio = track.stems.main.audio;
  } else if (track.stems.vocals.exists) {
    refAudio = track.stems.vocals.audio;
  } else if (track.stems.inst.audios.length > 0) {
    refAudio = track.stems.inst.audios[0].audio;
  }
  
  if (!refAudio) return;

  skipOpeningSilenceIfNeeded(trackNum, false);

  const current = refAudio.currentTime;
  const effectiveEnd = getEffectiveTrackEnd(trackNum, refAudio);
  updateMusicEndingWarning(trackNum);
  if (skipEndingSilence && !track.loopEnabled && track.silenceAnalysisReady
      && effectiveEnd > 0 && effectiveEnd < (refAudio.duration - 0.05)
      && current >= effectiveEnd) {
    logConsole(
      `Music: Skipped ${(refAudio.duration - effectiveEnd).toFixed(2)}s of ending silence on Track ${trackNum}`,
      'system'
    );
    handleTrackEnded(trackNum);
    return;
  }

  const duration = refAudio.duration || 0;
  const percent = duration > 0 ? (current / duration) * 100 : 0;
  
  updateProgressUI(trackNum, percent);
  const tcEl1 = document.getElementById(`time-current-${trackNum}`);
  if (tcEl1 && document.activeElement !== tcEl1) tcEl1.textContent = formatTime(current);
  
  syncStems(trackNum);
  updateEndSync(trackNum);
  updateMusicEndingWarning(trackNum);
  updateTrackPlatterPosition(trackNum, current);
}

// -------------------------------------------------------------
// Quantize Engine — Snap-to-beat helpers
// -------------------------------------------------------------

/**
 * Returns the reference HTMLAudioElement for a given track (first valid stem).
 */
function getRefAudio(trackNum) {
  const track = tracks[trackNum];
  if (track.stems.main.exists) return track.stems.main.audio;
  if (track.stems.vocals.exists) return track.stems.vocals.audio;
  if (track.stems.inst.audios.length > 0) return track.stems.inst.audios[0].audio;
  return null;
}

/**
 * Returns the number of seconds per beat for a track.
 */
function getSecondsPerBeat(trackNum) {
  const bpm = tracks[trackNum].bpmVal || 120;
  return 60.0 / bpm;
}

/**
 * Snaps a given time (seconds) to the nearest beat grid boundary.
 * Uses the track's beatOffset for phase alignment.
 * @param {number} trackNum
 * @param {number} time — the raw time in seconds
 * @param {string} mode — 'nearest' | 'next' | 'prev'
 * @returns {number} the snapped time in seconds
 */
function snapTimeToBeat(trackNum, time, mode = 'nearest') {
  const track = tracks[trackNum];
  const spb = getSecondsPerBeat(trackNum);
  const offset = track.beatOffset || 0;

  // How many beats (fractional) since the beat offset?
  const beatsElapsed = (time - offset) / spb;

  let snappedBeat;
  if (mode === 'next') {
    snappedBeat = Math.ceil(beatsElapsed + 0.001); // tiny epsilon to avoid snapping to current if exactly on beat
  } else if (mode === 'prev') {
    snappedBeat = Math.floor(beatsElapsed);
  } else {
    snappedBeat = Math.round(beatsElapsed);
  }

  return Math.max(0, offset + snappedBeat * spb);
}

/**
 * Returns the time in seconds until the next beat for a playing track.
 * If the track is not playing, returns 0.
 */
function getTimeUntilNextBeat(trackNum) {
  const refAudio = getRefAudio(trackNum);
  if (!refAudio || !tracks[trackNum].isPlaying) return 0;

  const currentTime = refAudio.currentTime;
  const nextBeatTime = snapTimeToBeat(trackNum, currentTime, 'next');
  return Math.max(0, (nextBeatTime - currentTime) / (tracks[trackNum].speedVal || 1.0));
}

/**
 * Schedules an action to execute on the next beat if quantize is enabled.
 * If quantize is off, the action runs immediately.
 * @param {number} trackNum — the track whose beat grid to snap to
 * @param {Function} action — the function to call when the beat arrives
 * @param {string} label — description for logging
 */
function quantizeAction(trackNum, action, label = 'action') {
  const track = tracks[trackNum];

  // Cancel any already-pending quantize timer
  if (track._quantizePendingTimer) {
    clearTimeout(track._quantizePendingTimer);
    track._quantizePendingTimer = null;
  }

  if (!track.quantizeEnabled || !track.isPlaying) {
    // No quantize or track not playing → run immediately
    action();
    return;
  }

  const delayMs = getTimeUntilNextBeat(trackNum) * 1000;

  if (delayMs < 15) {
    // Already on or very close to a beat → run immediately
    action();
    return;
  }

  logConsole(`Quantize: "${label}" scheduled in ${delayMs.toFixed(0)}ms (Track ${trackNum})`, 'system');

  track._quantizePendingTimer = setTimeout(() => {
    track._quantizePendingTimer = null;
    action();
  }, delayMs);
}

function getTrackMediaElements(trackNum) {
  const track = tracks[trackNum];
  const elements = [];
  if (track.stems.main.exists) elements.push(track.stems.main.audio);
  if (track.stems.vocals.exists) elements.push(track.stems.vocals.audio);
  track.stems.inst.audios.forEach(item => elements.push(item.audio));
  return elements;
}

function waitForMediaElementReady(audio, timeoutMs = 4000) {
  if (!audio || audio.error) return Promise.resolve(false);
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = ready => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('loadeddata', onReady);
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('abort', onError);
      resolve(ready);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(
      () => finish(audio.readyState >= HTMLMediaElement.HAVE_METADATA && !audio.error),
      timeoutMs
    );
    audio.addEventListener('loadeddata', onReady, { once: true });
    audio.addEventListener('canplay', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.addEventListener('abort', onError, { once: true });
  });
}

function prepareTrackMediaReadiness(trackNum) {
  const track = tracks[trackNum];
  const loadToken = ++track._mediaLoadToken;
  const mediaElements = getTrackMediaElements(trackNum);
  track._mediaReadyPromise = Promise.all(
    mediaElements.map(audio => waitForMediaElementReady(audio))
  ).then(results => ({ loadToken, results }));
  return track._mediaReadyPromise;
}

function playMediaElementWithTimeout(audio, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Playback start timed out')),
      timeoutMs
    );
    Promise.resolve(audio.play()).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function startMediaElementWithRetry(audio) {
  try {
    await playMediaElementWithTimeout(audio);
    return true;
  } catch (firstError) {
    const ready = await waitForMediaElementReady(audio, 2500);
    if (!ready) throw firstError;
    const retryPosition = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    audio.currentTime = Math.max(0, retryPosition);
    await playMediaElementWithTimeout(audio);
    return true;
  }
}

async function playTrack(trackNum) {
  cancelTrackWaveformReset(trackNum, true);
  initAudio(trackNum);
  const track = tracks[trackNum];
  const playRequestToken = ++track._playRequestToken;
  track._playPending = true;
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch (error) {
      logConsole(`Audio: Unable to resume output context (${error.message})`, 'err');
    }
  }
  if (playRequestToken !== track._playRequestToken) return;

  let hasValidStems = false;
  if (track.stems.main.exists || track.stems.vocals.exists || track.stems.inst.exists) {
    hasValidStems = true;
  }

  if (!hasValidStems && !notoMixerConfig.noAudioLoadedFallback) {
    track._playPending = false;
    track.isPlaying = false;
    logConsole(
      `Err: Track ${trackNum} has no loaded audio; fallback is disabled`,
      'err'
    );
    playErrorJingle();
    return;
  }

  // A jog released while the deck is paused can still have an active inertia
  // session. Settle it before starting the media elements; otherwise that
  // session continues seeking them and eventually pauses them while the deck
  // remains flagged as playing.
  if (trackScratchSessions.has(trackNum)) {
    endTrackScratch(trackNum, { fadeSeconds: 0, allowInertia: false });
  }

  // Handle master track assignment
  const otherNum = (trackNum === 1) ? 2 : 1;
  if (!tracks[otherNum].isPlaying) {
    masterTrackNum = trackNum;
    logConsole(`Sync: Track ${trackNum} is now MASTER`, 'system');
  }

  if (hasValidStems) {
    const playButton = document.getElementById(`btn-play-${trackNum}`);
    if (playButton) playButton.textContent = 'LOADING';

    try {
      const readiness = await track._mediaReadyPromise;
      if (
        playRequestToken !== track._playRequestToken
        || readiness.loadToken !== track._mediaLoadToken
      ) {
        return;
      }

      const refAudio = getRefAudio(trackNum);
      if (
        refAudio
        && Number.isFinite(refAudio.duration)
        && refAudio.duration > 0
        && (!Number.isFinite(refAudio.currentTime)
          || refAudio.currentTime >= refAudio.duration - 0.05)
      ) {
        setTrackMediaTime(trackNum, 0);
      }

      skipOpeningSilenceIfNeeded(trackNum);
    
    // If sync is enabled, lock tempo and phase
      if (track.syncEnabled) {
        performBeatSync(trackNum);
      }
    
      const mediaElements = getTrackMediaElements(trackNum);
      mediaElements.forEach(audio => {
        audio.preservesPitch = false;
        audio.playbackRate = track.speedVal;
      });
      const playResults = await Promise.allSettled(
        mediaElements.map(audio => startMediaElementWithRetry(audio))
      );
      if (playRequestToken !== track._playRequestToken) {
        mediaElements.forEach(audio => audio.pause());
        return;
      }

      const startedCount = playResults.filter(result => result.status === 'fulfilled').length;
      playResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          logConsole(
            `Err: Cannot play media ${index + 1} on track ${trackNum}: ${result.reason?.message || result.reason}`,
            'err'
          );
        }
      });
      if (startedCount === 0) throw new Error('No loaded media element could start playback');

      track.isPlaying = true;
      track._playPending = false;
      if (track.syncEnabled) performBeatSync(trackNum);

      document.getElementById(`btn-play-${trackNum}`).classList.add('playing');
      document.getElementById(`btn-play-${trackNum}`).textContent = 'PAUSE';
      sendSerialMessage(`T${trackNum}:PLAYING:1`);
    } catch (error) {
      if (playRequestToken !== track._playRequestToken) return;
      track._playPending = false;
      track.isPlaying = false;
      const playButton = document.getElementById(`btn-play-${trackNum}`);
      if (playButton) {
        playButton.classList.remove('playing');
        playButton.textContent = 'PLAY';
      }
      logConsole(`Err: Cannot start Track ${trackNum}: ${error.message}`, 'err');
      playErrorJingle();
      publishTabletControllerState(true);
      return;
    }
  } else {
    // Play electronic beats fallback / demo mode
    track.isPlaying = true;
    track._playPending = false;
    startSynthDemo(trackNum);
    document.getElementById(`btn-play-${trackNum}`).classList.add('playing');
    document.getElementById(`btn-play-${trackNum}`).textContent = 'PAUSE';
    sendSerialMessage(`T${trackNum}:PLAYING:1`);
    logConsole(`Info: Start Synth Demo for Track ${trackNum}`, 'system');
  }

  if (track.metronomeOn) {
    startMetronome(trackNum);
  }

  updateEndSync(trackNum);
  updateEndSyncMissingTargetAlert(trackNum, true);
  updateMusicEndingWarning(trackNum);
  updateTrackPlatterPlayback(trackNum);

  // Flash play button on screen
  const btn = document.getElementById(`btn-play-${trackNum}`);
  if (btn) {
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 50);
  }
}

function pauseTrack(trackNum) {
  const track = tracks[trackNum];
  track._playRequestToken += 1;
  track._playPending = false;
  const wasFadingOut =
    track._endSyncFadeRole === 'out' || track.endSyncFadeOutStarted;
  if (track._endSyncFadeRole || wasFadingOut) {
    cancelEndSyncTrackFade(trackNum, true);
  }
  if (wasFadingOut) track.endSyncFadeOutStarted = false;
  track.isPlaying = false;
  endTrackScratch(trackNum, { fadeSeconds: 0, allowInertia: false });
  updateTrackPlatterPlayback(trackNum);
  clearEndSyncTimer(trackNum);
  clearEndSyncFinalFlash(trackNum);
  updateMusicEndingWarning(trackNum);
  document.getElementById(`btn-play-${trackNum}`).classList.remove('playing');
  document.getElementById(`btn-play-${trackNum}`).textContent = 'PLAY';
  sendSerialMessage(`T${trackNum}:PLAYING:0`);
  
  // Update Master track assignment if paused track was Master
  const otherNum = (trackNum === 1) ? 2 : 1;
  if (masterTrackNum === trackNum && tracks[otherNum].isPlaying) {
    masterTrackNum = otherNum;
    logConsole(`Sync: Track ${otherNum} is now MASTER (previous paused)`, 'system');
  }
  
  if (track.isSynth) {
    stopSynthDemo(trackNum);
  } else {
    if (track.stems.main.exists) track.stems.main.audio.pause();
    if (track.stems.vocals.exists) track.stems.vocals.audio.pause();
    track.stems.inst.audios.forEach(item => item.audio.pause());
  }
  if (track.metronomeOn) {
    stopMetronome(trackNum);
  }
  logConsole(`Info: Pause Track ${trackNum}`, 'system');

  // Flash play button on screen when pausing
  const btn = document.getElementById(`btn-play-${trackNum}`);
  if (btn) {
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 50);
  }
}

function togglePlayTrack(trackNum) {
  const track = tracks[trackNum];
  if (track.isPlaying || track._playPending) {
    pauseTrack(trackNum);
  } else {
    // Quantize: if Q is on and the OTHER track is playing, wait for next beat
    const otherNum = (trackNum === 1) ? 2 : 1;
    const otherTrack = tracks[otherNum];
    if (track.quantizeEnabled && otherTrack.isPlaying) {
      quantizeAction(otherNum, () => playTrack(trackNum), `Play Track ${trackNum}`);
    } else {
      playTrack(trackNum);
    }
  }
}

function stopTrack(trackNum, { preserveOwnedFades = false } = {}) {
  const track = tracks[trackNum];
  track._playRequestToken += 1;
  track._playPending = false;
  const hadEndSyncFade =
    Boolean(track._endSyncFadeRole) || track.endSyncFadeOutStarted;
  if (!preserveOwnedFades) {
    cancelEndSyncFadesForOwner(trackNum);
  }
  if (hadEndSyncFade) {
    cancelEndSyncTrackFade(trackNum, true);
  }
  track.isPlaying = false;
  endTrackScratch(trackNum, { fadeSeconds: 0, allowInertia: false });
  track.endSyncMixStarted = false;
  track.endSyncFadeOutStarted = false;
  updateTrackPlatterPlayback(trackNum);
  resetEndSyncRamp(trackNum, true);
  updateMusicEndingWarning(trackNum);
  document.getElementById(`btn-play-${trackNum}`).classList.remove('playing');
  document.getElementById(`btn-play-${trackNum}`).textContent = 'PLAY';
  sendSerialMessage(`T${trackNum}:PLAYING:0`);
  
  // Update Master track assignment if stopped track was Master
  const otherNum = (trackNum === 1) ? 2 : 1;
  if (masterTrackNum === trackNum && tracks[otherNum].isPlaying) {
    masterTrackNum = otherNum;
    logConsole(`Sync: Track ${otherNum} is now MASTER (previous stopped)`, 'system');
  }
  
  if (track.isSynth) {
    stopSynthDemo(trackNum);
    updateProgressUI(trackNum, 0);
    const tcEl2 = document.getElementById(`time-current-${trackNum}`);
    if (tcEl2 && document.activeElement !== tcEl2) tcEl2.textContent = '0:00';
  } else {
    if (track.stems.main.exists) {
      track.stems.main.audio.pause();
      track.stems.main.audio.currentTime = 0;
    }
    if (track.stems.vocals.exists) {
      track.stems.vocals.audio.pause();
      track.stems.vocals.audio.currentTime = 0;
    }
    track.stems.inst.audios.forEach(item => {
      item.audio.pause();
      item.audio.currentTime = 0;
    });
    updateProgressUI(trackNum, 0);
    const tcEl3 = document.getElementById(`time-current-${trackNum}`);
    if (tcEl3 && document.activeElement !== tcEl3) tcEl3.textContent = '0:00';
  }
  if (track.metronomeOn) {
    stopMetronome(trackNum);
  }
  logConsole(`Info: Stop Track ${trackNum}`, 'system');

  // Flash stop button on screen
  const btn = document.getElementById(`btn-stop-${trackNum}`);
  if (btn) {
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 50);
  }
}

function setVolume(trackNum, value) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  if (track._endSyncFadeRole) {
    const wasFadingOut = track._endSyncFadeRole === 'out';
    cancelEndSyncTrackFade(trackNum, false);
    if (wasFadingOut) track.endSyncFadeOutStarted = false;
  }
  value = Math.max(0, Math.min(100, value));
  
  const normalized = value / 100;
  if (track.gainNode) {
    track.gainNode.gain.setValueAtTime(normalized, audioCtx.currentTime);
  }
  updateVolUI(trackNum, value);
}

function setEQ(trackNum, param, val) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  let filter = null;
  
  switch(param) {
    case 'bass': filter = track.bassFilter; break;
    case 'low': filter = track.lowFilter; break;
    case 'treb': filter = track.trebFilter; break;
  }
  
  if (filter) {
    filter.gain.setValueAtTime(val, audioCtx.currentTime);
    updateKnobUI(trackNum, param, val);
  }
}

function setStemVolume(trackNum, stemKey, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  const normalized = value / 100;
  
  if (stemKey === 'inst') {
    if (track.stems.inst.gainNode) {
      track.stems.inst.gainNode.gain.setValueAtTime(normalized, audioCtx.currentTime);
    }
    updateKnobUI(trackNum, 'inst', value);
  } else {
    // Static stems (main or vocals)
    const stem = track.stems[stemKey];
    if (stem.gainNode) {
      stem.gainNode.gain.setValueAtTime(normalized, audioCtx.currentTime);
    }
    const paramDisplay = stemKey === 'main' ? 'main' : 'voc';
    updateKnobUI(trackNum, paramDisplay, value);
  }
}

function setPitch(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];

  value = Number(value);
  if (!Number.isFinite(value)) return;
  value = Math.max(-12, Math.min(12, value));
  
  // Snap very small values (close to 0) to exactly 0 (helps with analog noise and visual center snapping)
  if (Math.abs(value) < 0.05) {
    value = 0;
  }
  
  const wasPitchActive = (track.pitchVal !== 0);
  track.pitchVal = value; // semitones, -12 to 12
  
  const pitchFactor = Math.pow(2, value / 12);
  if (track.pitchShifter) {
    track.pitchShifter.setPitch(pitchFactor);
  }
  
  const isPitchActive = (value !== 0);
  if (wasPitchActive !== isPitchActive) {
    updateAudioGraphConnections(trackNum);
  }
  
  updateTrackPitchUI(trackNum);
}

function setSpeed(trackNum, value, options = {}) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.speedVal = value / 100; // factor, e.g. 0.5 to 2.0
  
  // Vinyl-style tempo changes: let pitch follow playback speed to avoid the
  // metallic artifacts introduced by Chromium's real-time pitch preservation.
  if (track.stems.main.exists) {
    track.stems.main.audio.preservesPitch = false;
    track.stems.main.audio.playbackRate = track.speedVal;
  }
  if (track.stems.vocals.exists) {
    track.stems.vocals.audio.preservesPitch = false;
    track.stems.vocals.audio.playbackRate = track.speedVal;
  }
  track.stems.inst.audios.forEach(item => {
    item.audio.preservesPitch = false;
    item.audio.playbackRate = track.speedVal;
  });
  
  updateKnobUI(trackNum, 'speed', value);
  updateTrackPitchUI(trackNum);
  
  if (track.bpmVal) {
    const bpmInput = document.getElementById(`bpm-${trackNum}`);
    if (bpmInput) {
      // If speed is 100%, show base BPM exactly, otherwise calculate effective BPM
      let effectiveBPM = (Math.abs(track.speedVal - 1.0) < 0.001) ? track.bpmVal : (track.bpmVal * track.speedVal);
      bpmInput.value = Math.round(effectiveBPM);
    }
  }

  // Restart metronome if active to match the new speed
  if (track.metronomeOn && !options.skipMetronomeRestart) {
    startMetronome(trackNum);
  }

  // If the other track is synced to this one, match its tempo speed
  const otherNum = (trackNum === 1) ? 2 : 1;
  const otherTrack = tracks[otherNum];
  if (!options.suppressSyncPropagation && otherTrack.syncEnabled && otherTrack.bpmVal) {
    const targetBpm = (track.bpmVal * track.speedVal);
    const newOtherSpeedVal = targetBpm / otherTrack.bpmVal;
    
    // Only update if difference is significant to avoid rounding loop updates
    if (Math.abs(otherTrack.speedVal - newOtherSpeedVal) > 0.0001) {
      setSpeed(otherNum, newOtherSpeedVal * 100);
    }
  }

  updateEndSyncMissingTargetAlert(trackNum, true);
  updateMusicEndingWarning(trackNum);
  updateTrackPlatterPlayback(trackNum);
}

function setEcho(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.echoVal = value; // 0 to 100
  
  const feedback = (value / 100) * 0.75;
  const wet = (value / 100) * 0.6;
  
  if (track.echoFeedbackNode) {
    track.echoFeedbackNode.gain.setValueAtTime(feedback, audioCtx.currentTime);
  }
  if (track.echoWetNode) {
    track.echoWetNode.gain.setValueAtTime(wet, audioCtx.currentTime);
  }
  
  updateKnobUI(trackNum, 'echo', value);
}

function setFilter(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.filterVal = value;
  
  if (value === 50) {
    if (track.filterLPFNode) track.filterLPFNode.frequency.setValueAtTime(22000, audioCtx.currentTime);
    if (track.filterHPFNode) track.filterHPFNode.frequency.setValueAtTime(20, audioCtx.currentTime);
  } else if (value < 50) {
    const pct = value / 50;
    const freq = 20 * Math.pow(22000 / 20, pct);
    if (track.filterLPFNode) track.filterLPFNode.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (track.filterHPFNode) track.filterHPFNode.frequency.setValueAtTime(20, audioCtx.currentTime);
  } else {
    const pct = (value - 50) / 50;
    const freq = 20 * Math.pow(20000 / 20, pct);
    if (track.filterLPFNode) track.filterLPFNode.frequency.setValueAtTime(22000, audioCtx.currentTime);
    if (track.filterHPFNode) track.filterHPFNode.frequency.setValueAtTime(freq, audioCtx.currentTime);
  }
  
  updateKnobUI(trackNum, 'filter', value);
}

function setPan(trackNum, value) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.panVal = value;
  if (track.panNode) {
    track.panNode.pan.setValueAtTime(value / 100, audioCtx.currentTime);
  }
  updateKnobUI(trackNum, 'pan', value);
}

function setReverb(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.reverbVal = value;
  if (track.reverbWetNode) {
    track.reverbWetNode.gain.setValueAtTime((value / 100) * 0.8, audioCtx.currentTime);
  }
  updateKnobUI(trackNum, 'reverb', value);
}

function setEchoTime(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.echoTimeVal = value;
  if (track.echoDelayNode) {
    track.echoDelayNode.delayTime.setValueAtTime(value / 1000, audioCtx.currentTime);
  }
  updateKnobUI(trackNum, 'echotime', value);
}

function startMetronome(trackNum) {
  stopMetronome(trackNum);
  const track = tracks[trackNum];
  if (!track.metronomeOn) return;
  
  initAudio(trackNum);
  
  let nextNoteTime = audioCtx.currentTime;
  let beatCount = 0;
  
  track.metronomeIntervalId = setInterval(() => {
    const scheduleAheadTime = 0.1; // Schedule 100ms in advance
    const bpm = track.bpmVal || 120;
    const speed = track.speedVal || 1.0;
    
    let beatDuration = 60 / bpm;
    if (track.bpmDivVal === '1/2') {
      beatDuration = beatDuration / 2;
    } else if (track.bpmDivVal === '1/4') {
      beatDuration = beatDuration / 4;
    }
    
    // Scale by track speed factor
    beatDuration = beatDuration / speed;
    
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      const isDownbeat = (beatCount % 4 === 0);
      
      // Metronome clicks run when track is playing
      if (track.isPlaying) {
        try {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.connect(gain).connect(audioCtx.destination);
          
          osc.frequency.setValueAtTime(isDownbeat ? 1200 : 800, nextNoteTime);
          gain.gain.setValueAtTime(0.2, nextNoteTime); // Full, clear volume bypass
          gain.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + 0.04);
          
          osc.start(nextNoteTime);
          osc.stop(nextNoteTime + 0.05);
        } catch(e) {}
      }
      
      nextNoteTime += beatDuration;
      beatCount++;
    }
  }, 40); // Checked every 40ms
}

function stopMetronome(trackNum) {
  const track = tracks[trackNum];
  if (track.metronomeIntervalId) {
    clearInterval(track.metronomeIntervalId);
    track.metronomeIntervalId = null;
  }
}

const tapTempoStates = new Map();

function registerTapTempo(stateKey, button, applyTempo, persistTempo = null) {
  const now = performance.now();
  let state = tapTempoStates.get(stateKey);
  if (!state) {
    state = {
      timestamps: [],
      feedbackTimer: null,
      settleTimer: null,
      lastBpm: null
    };
    tapTempoStates.set(stateKey, state);
  }

  if (state.settleTimer) {
    clearTimeout(state.settleTimer);
    state.settleTimer = null;
  }

  const lastTap = state.timestamps[state.timestamps.length - 1];
  if (lastTap === undefined || now - lastTap > 2000) {
    state.timestamps = [now];
    state.lastBpm = null;
  } else if (now - lastTap >= 200) {
    state.timestamps.push(now);
    if (state.timestamps.length > 9) state.timestamps.shift();
  }

  let tappedBpm = null;
  if (state.timestamps.length >= 2) {
    const intervals = [];
    for (let i = 1; i < state.timestamps.length; i++) {
      intervals.push(state.timestamps[i] - state.timestamps[i - 1]);
    }

    const sortedIntervals = intervals.slice().sort((a, b) => a - b);
    const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    const stableIntervals = intervals.filter(interval => (
      Math.abs(interval - medianInterval) <= medianInterval * 0.25
    ));
    const averageInterval = stableIntervals.reduce((sum, interval) => sum + interval, 0)
      / stableIntervals.length;
    tappedBpm = Math.round(60000 / averageInterval);

    if (tappedBpm >= 20 && tappedBpm <= 300) {
      applyTempo(tappedBpm);
      state.lastBpm = tappedBpm;
      button.title = `Tap tempo — ${tappedBpm} BPM`;
    } else {
      tappedBpm = null;
    }
  }

  if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
  button.classList.remove('tap-feedback');
  void button.offsetWidth;
  button.classList.add('tap-feedback');
  button.textContent = tappedBpm === null ? 'TAP' : String(tappedBpm);
  state.feedbackTimer = setTimeout(() => {
    button.classList.remove('tap-feedback');
    button.textContent = 'TAP';
    state.feedbackTimer = null;
  }, 550);

  if (state.lastBpm !== null && typeof persistTempo === 'function') {
    state.settleTimer = setTimeout(() => {
      const finalBpm = state.lastBpm;
      state.timestamps = [];
      state.lastBpm = null;
      state.settleTimer = null;
      Promise.resolve(persistTempo(finalBpm)).catch(error => {
        logConsole(`Tap BPM: Unable to save tempo (${error.message})`, 'err');
      });
    }, 5000);
  }
}

function tapTrackTempo(trackNum) {
  const button = document.getElementById(`btn-tap-${trackNum}`);
  if (!button) return;
  registerTapTempo(`track-${trackNum}`, button, bpm => {
    setBPM(trackNum, bpm);
  }, () => {
    return persistTappedBpmToSong(
      tracks[trackNum].dirPath,
      tracks[trackNum].bpmVal,
      `Track ${trackNum}`
    );
  });
}

function tapPreviewTempo() {
  const button = document.getElementById('prev-btn-tap');
  if (!button) return;
  registerTapTempo('preview', button, bpm => {
    prevBpmVal = bpm;
    const bpmInput = document.getElementById('prev-bpm');
    if (bpmInput) bpmInput.value = bpm;
    if (prevMetronomeOn) startPreviewMetronome();
  }, () => {
    return persistTappedBpmToSong(previewSongPath, prevBpmVal, 'Preview');
  });
}

async function persistTappedBpmToSong(songPath, baseBpm, sourceLabel) {
  if (!songPath || !Number.isFinite(baseBpm)) {
    logConsole(`Tap BPM: ${sourceLabel} has no loaded song; BPM was not saved`, 'err');
    return false;
  }

  const { mainAudioPath, audioFiles } = resolveSongAnalysisFiles(songPath);
  if (!mainAudioPath || audioFiles.length === 0) {
    logConsole(`Tap BPM: No analyzable audio found for ${sourceLabel}`, 'err');
    return false;
  }

  const normalizedBpm = Math.round(baseBpm * 100) / 100;
  const analysisKey = getSongAnalysisKey(mainAudioPath);
  const fileManifest = buildPortableAudioManifest(audioFiles);
  const portableRecord = getPortableSongAnalysisRecord(songPath);
  let cached = portableRecord
    ? hydratePortableSongAnalysis(portableRecord, songPath, mainAudioPath)
    : null;

  const verified = verifiedSongAnalysis.get(analysisKey);
  if (!cached && verified) {
    cached = {
      ...verified,
      waveformData: encodeWaveformPeaks(verified.waveformPeaks || [])
    };
    delete cached.waveformPeaks;
  }

  if (!cached) {
    const waveformPeaks = sourceLabel === 'Preview'
      ? (previewStaticWaveform || [])
      : (() => {
          const trackNum = sourceLabel === 'Track 1' ? 1 : 2;
          return tracks[trackNum].staticWaveform || [];
        })();
    if (waveformPeaks.length === 0) {
      logConsole(`Tap BPM: Analysis cache is not ready for ${sourceLabel}`, 'err');
      return false;
    }

    const md5 = await calculateSongMd5(audioFiles);
    const refAudio = sourceLabel === 'Preview'
      ? (previewStems.main.exists
          ? previewStems.main.audio
          : previewStems.vocals.exists
            ? previewStems.vocals.audio
            : previewStems.inst.audios[0] && previewStems.inst.audios[0].audio)
      : getRefAudio(sourceLabel === 'Track 1' ? 1 : 2);
    const duration = refAudio && Number.isFinite(refAudio.duration) ? refAudio.duration : 0;
    cached = {
      cacheVersion: SONG_ANALYSIS_CACHE_VERSION,
      md5,
      songPath,
      mainAudioPath,
      bpm: normalizedBpm,
      key: '--',
      duration,
      offset: 0,
      peaks: downsampleWaveformPeaks(waveformPeaks, 60),
      waveformData: encodeWaveformPeaks(waveformPeaks),
      silenceStart: 0,
      silenceEnd: duration,
      cover: '',
      analyzedAt: Date.now()
    };
  }

  cached.bpm = normalizedBpm;
  cached.bpmManuallySet = true;
  cached.bpmUpdatedAt = Date.now();
  storePortableSongAnalysis(songPath, cached, fileManifest);

  if (verified) {
    verified.bpm = normalizedBpm;
    verified.bpmManuallySet = true;
    verified.bpmUpdatedAt = cached.bpmUpdatedAt;
  } else {
    verifiedSongAnalysis.set(analysisKey, {
      ...cached,
      waveformPeaks: decodeWaveformPeaks(cached.waveformData)
    });
  }

  document.querySelectorAll('#songs-list li[data-folder]').forEach(songItem => {
    const itemPath = path.join(workingDir, songItem.dataset.folder);
    if (getSongAnalysisKey(itemPath) !== getSongAnalysisKey(songPath)) return;
    songItem.dataset.bpm = String(normalizedBpm);
    const bpmElement = songItem.querySelector('.song-item-bpm');
    if (bpmElement) bpmElement.textContent = `${normalizedBpm} BPM`;
  });
  updateBpmCompatIndicators();
  publishTabletSongLibrary();
  logConsole(
    `Tap BPM: Saved ${normalizedBpm} BPM to ${path.basename(songPath)} after 5 seconds`,
    'system'
  );
  return true;
}

function setBPM(trackNum, val) {
  const track = tracks[trackNum];
  val = Math.max(20, Math.min(300, val));
  
  // The value is the effective BPM; set the base BPM accordingly
  const speed = track.speedVal || 1.0;
  track.bpmVal = val / speed;
  
  const input = document.getElementById(`bpm-${trackNum}`);
  if (input) input.value = val;
  
  if (track.metronomeOn) {
    startMetronome(trackNum);
  }

  // Update BPM compatibility indicators in songs list
  if (typeof updateBpmCompatIndicators === 'function') {
    updateBpmCompatIndicators();
  }
  updateEndSyncMissingTargetAlert(trackNum, true);
  updateMusicEndingWarning(trackNum);
}

function setBPMDiv(trackNum, val) {
  const track = tracks[trackNum];
  track.bpmDivVal = val;
  
  const select = document.getElementById(`bpmdiv-${trackNum}`);
  if (select) select.value = val;
  
  if (track.metronomeOn) {
    startMetronome(trackNum);
  }
}

function toggleMetronome(trackNum) {
  const track = tracks[trackNum];
  track.metronomeOn = !track.metronomeOn;
  
  const btn = document.getElementById(`btn-metro-${trackNum}`);
  if (btn) {
    if (track.metronomeOn) {
      btn.classList.add('active');
      startMetronome(trackNum);
      logConsole(`Metronome Channel ${trackNum} ACTIVE (BPM: ${track.bpmVal}, Division: ${track.bpmDivVal})`, 'system');
    } else {
      btn.classList.remove('active');
      stopMetronome(trackNum);
      logConsole(`Metronome Channel ${trackNum} DEACTIVATED`, 'system');
    }
  }
}

function seekTrack(trackNum, percent, forceNoAudioSeek = false) {
  cancelTrackWaveformReset(trackNum);
  const track = tracks[trackNum];
  
  let duration = 180; // default 3 min simulated duration if empty
  let hasAudio = false;

  if (!track.isSynth) {
    if (track.stems.main.exists && track.stems.main.audio.duration) {
      duration = track.stems.main.audio.duration;
      hasAudio = true;
    } else if (track.stems.vocals.exists && track.stems.vocals.audio.duration) {
      duration = track.stems.vocals.audio.duration;
      hasAudio = true;
    } else if (track.stems.inst.audios.length > 0 && track.stems.inst.audios[0].audio.duration) {
      duration = track.stems.inst.audios[0].audio.duration;
      hasAudio = true;
    }
  }

  const time = (percent / 100) * duration;

  if (hasAudio && !track.isSynth && !forceNoAudioSeek) {
    initAudio(trackNum);
    if (track.stems.main.exists) track.stems.main.audio.currentTime = time;
    if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = time;
    track.stems.inst.audios.forEach(item => {
      item.audio.currentTime = time;
    });
    
    // Snap phase back to sync grid if sync is enabled
    if (tracks[1].syncEnabled) performBeatSync(1);
    if (tracks[2].syncEnabled) performBeatSync(2);
  }

  updateProgressUI(trackNum, percent);
  const tcEl4 = document.getElementById(`time-current-${trackNum}`);
  if (tcEl4 && document.activeElement !== tcEl4) tcEl4.textContent = formatTime(time);
  if (!hasAudio && !track.isSynth) {
    document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(duration);
  }
  updateMusicEndingWarning(trackNum);
}

// -------------------------------------------------------------
// Synthesizer Beat Generator (Demo Mode)
// -------------------------------------------------------------

function startSynthDemo(trackNum) {
  if (!audioCtx) return;
  const track = tracks[trackNum];
  if (track.synthTimer) {
    clearInterval(track.synthTimer);
    track.synthTimer = null;
  }
  
  track.isSynth = true;
  document.getElementById(`track-name-${trackNum}`).textContent = `TEST AUDIO ${trackNum}`;
  document.getElementById(`time-duration-${trackNum}`).textContent = '--:--';
  
  if (track.fallbackWaveform) {
    track.staticWaveform = track.fallbackWaveform;
  } else {
    track.staticWaveform = Array.from({length: 2000}, () => Math.random() * 0.5 + 0.25);
  }
  
  ['inst', 'main', 'vocals'].forEach(key => {
    const indicator = document.getElementById(`ind-${key}-${trackNum}`);
    if (indicator) indicator.classList.remove('present');
    const cellId = key === 'main' ? 'main' : key === 'vocals' ? 'voc' : 'inst';
    const cell = document.getElementById(`cell-${cellId}-${trackNum}`);
    if (cell) cell.classList.add('disabled');
  });

  ['filter', 'pitch', 'speed', 'echo', 'reverb', 'echotime'].forEach(key => {
    const cell = document.getElementById(`cell-${key}-${trackNum}`);
    if (cell) cell.classList.add('disabled');
  });

  const bpmInput = document.getElementById(`bpm-${trackNum}`);
  if (bpmInput && bpmInput.parentElement && bpmInput.parentElement.parentElement) {
    bpmInput.parentElement.parentElement.classList.add('disabled-control');
  }
  
  const bpmDiv = document.getElementById(`bpmdiv-${trackNum}`);
  if (bpmDiv && bpmDiv.parentElement) {
    bpmDiv.parentElement.classList.add('disabled-control');
  }
  
  const metroBtn = document.getElementById(`btn-metro-${trackNum}`);
  if (metroBtn && metroBtn.parentElement) {
    metroBtn.parentElement.classList.add('disabled-control');
  }

  const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
  if (syncBtn) syncBtn.classList.add('disabled-control');

  const endSyncBtn = document.getElementById(`btn-end-sync-${trackNum}`);
  if (endSyncBtn) endSyncBtn.classList.add('disabled-control');
  
  const quantizeBtn = document.getElementById(`btn-quantize-${trackNum}`);
  if (quantizeBtn) quantizeBtn.classList.add('disabled-control');

  if (!track.fallbackAudio) {
    track.fallbackAudio = new Audio(
      getNotoMixerAssetUrl('audio', 'test-audio.mp3')
    );
    track.fallbackAudio.loop = true;
    const source = audioCtx.createMediaElementSource(track.fallbackAudio);
    source.connect(track.gainNode);
    
    // Analyze BPM, Offset, and Waveform for the test audio
    fetch(getNotoMixerAssetUrl('audio', 'test-audio.mp3'))
      .then(res => res.arrayBuffer())
      .then(ab => audioCtx.decodeAudioData(ab))
      .then(buffer => {
        const detectedBpm = estimateBPM(buffer);
        const detectedOffset = estimateBeatOffset(buffer, detectedBpm);
        
        track.fallbackBpm = detectedBpm;
        track.fallbackOffset = detectedOffset;
        
        if (track.isSynth) {
          track.beatOffset = detectedOffset;
          setBPM(trackNum, detectedBpm);
          logConsole(`BPM: Analyzed test audio -> ${detectedBpm} BPM`, 'system');
        }
        
        const numPeaks = 2000;
        const rawData = buffer.getChannelData(0);
        const L = rawData.length;
        const SR = buffer.sampleRate;
        const duration = buffer.duration;
        const peaks = new Float32Array(numPeaks);
        
        for (let i = 0; i < numPeaks; i++) {
          const startTime = (i / numPeaks) * duration;
          const endTime = ((i + 1) / numPeaks) * duration;
          const startIdx = Math.floor(startTime * SR);
          const endIdx = Math.min(L, Math.floor(endTime * SR));
          if (endIdx > startIdx) {
            let sum = 0;
            for (let j = startIdx; j < endIdx; j++) {
              sum += Math.abs(rawData[j]);
            }
            peaks[i] = sum / (endIdx - startIdx);
          }
        }
        const maxVal = Math.max(...peaks);
        track.fallbackWaveform = Array.from(peaks).map(p => p / (maxVal || 1));
        
        if (track.isSynth) {
          track.staticWaveform = track.fallbackWaveform;
        }
      })
      .catch(e => console.error('Failed to analyze test audio:', e));
    
    track.fallbackAudio.addEventListener('timeupdate', () => {
      if (!track.isSynth) return;
      const dur = track.fallbackAudio.duration;
      const cur = track.fallbackAudio.currentTime;
      if (dur > 0) {
        const pct = (cur / dur) * 100;
        updateProgressUI(trackNum, pct);
        const tcEl5 = document.getElementById(`time-current-${trackNum}`);
        if (tcEl5 && document.activeElement !== tcEl5) tcEl5.textContent = formatTime(cur);
        document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(dur);
      }
    });
  } else {
    // If already analyzed, re-apply the cached BPM immediately
    if (track.fallbackBpm) {
      track.beatOffset = track.fallbackOffset;
      setBPM(trackNum, track.fallbackBpm);
    }
  }
  
  track.fallbackAudio.playbackRate = track.speedVal || 1.0;
  track.fallbackAudio.play().catch(e => logConsole(`Err: ${e.message}`, 'err'));
}

function stopSynthDemo(trackNum) {
  const track = tracks[trackNum];
  if (track.synthTimer) {
    clearInterval(track.synthTimer);
    track.synthTimer = null;
  }
  
  if (track.fallbackAudio) {
    track.fallbackAudio.pause();
    track.fallbackAudio.currentTime = 0;
  }
  
  track.isSynth = false;
  track.staticWaveform = null;
  track.synthStep = 0;
  
  ['inst', 'main', 'vocals'].forEach(key => {
    const indicator = document.getElementById(`ind-${key}-${trackNum}`);
    if (indicator) indicator.className = 'stem-indicator';
    const cellId = key === 'main' ? 'main' : key === 'vocals' ? 'voc' : 'inst';
    const cell = document.getElementById(`cell-${cellId}-${trackNum}`);
    if (cell) cell.classList.add('disabled');
  });
}

function playSynthStep(trackNum, step) {
  const track = tracks[trackNum];
  const time = audioCtx.currentTime;
  
  if (track.stems.inst.gainNode && step % 4 === 0) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(track.stems.inst.gainNode);
    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.15);
    gain.gain.setValueAtTime(1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.15);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  // Generate Sound on MAIN Stem (Rhythmic melody)
  if (track.stems.main.gainNode && step % 2 === 1) {
    const notes = [65.4, 73.4, 82.4, 98.0, 110];
    const note = notes[(step + trackNum) % notes.length];
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(track.stems.main.gainNode);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(note, time);
    gain.gain.setValueAtTime(0.25, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);
    osc.start(time);
    osc.stop(time + 0.22);
  }

  // Generate Sound on VOCALS Stem (High synth melody notes)
  if (track.stems.vocals.gainNode && (step % 4 === 2 || step % 8 === 6)) {
    const notes = [329.6, 392, 523.3, 659.3];
    const note = notes[(step * trackNum) % notes.length];
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(track.stems.vocals.gainNode);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note, time);
    gain.gain.setValueAtTime(0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.18);
    osc.start(time);
    osc.stop(time + 0.2);
  }
}

// -------------------------------------------------------------
// Interactive UI Listeners (Sliders, Drag Knobs, Drag & Drop)
// -------------------------------------------------------------

function activateTrackHotCue(trackNum, cueIndex, button, mode = 'play') {
  const track = tracks[trackNum];
  const cueTime = track.hotCues[cueIndex];
  if (!Number.isFinite(cueTime)) return;
  cancelTrackWaveformReset(trackNum);

  if (mode === 'hold') {
    const refAudio = getRefAudio(trackNum) || (track.isSynth ? track.fallbackAudio : null);
    if (refAudio) button.dataset.holdReturnTime = refAudio.currentTime;
    button.dataset.holdWasPlaying = track.isPlaying;
    button.classList.add('holding');
    track.activeHoldCueIdx = cueIndex;
  }

  setTrackMediaTime(trackNum, cueTime);
  if (track.isSynth && track.fallbackAudio) track.fallbackAudio.currentTime = cueTime;
  handleTrackProgress(trackNum);

  button.classList.add('playing');
  if (mode === 'play') {
    setTimeout(() => button.classList.remove('playing'), 150);
  }

  if (!track.isPlaying) {
    const playButton = document.getElementById(`btn-play-${trackNum}`);
    if (playButton) playButton.click();
  }
}

function setupUIListeners() {
  [1, 2].forEach(trackNum => {
    // Play button
    document.getElementById(`btn-play-${trackNum}`).addEventListener('click', () => {
      togglePlayTrack(trackNum);
    });

    // Stop button
    document.getElementById(`btn-stop-${trackNum}`).addEventListener('click', () => {
      stopTrack(trackNum);
    });

    // Beat Sync button
    const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        toggleBeatSync(trackNum);
      });
      
      syncBtn.addEventListener('mouseenter', () => {
        const otherNum = (trackNum === 1) ? 2 : 1;
        const target = tracks[trackNum];
        const source = tracks[otherNum];
        
        let targetSpeedPercentage = 100;
        let targetBPM = target.bpmVal;

        if (target.syncEnabled) {
          // Preview turning OFF (resets to 100%)
          targetSpeedPercentage = 100;
          targetBPM = target.bpmVal;
        } else if (target.bpmVal && source.bpmVal) {
          // Preview turning ON (matches other track)
          const sourceCurrentBpm = source.bpmVal * (source.speedVal || 1.0);
          const newSpeedVal = sourceCurrentBpm / target.bpmVal;
          targetSpeedPercentage = newSpeedVal * 100;
          targetBPM = sourceCurrentBpm;
        } else {
          return;
        }
        
        updateKnobUI(trackNum, 'speed', targetSpeedPercentage);
        
        const speedSpan = document.getElementById(`val-speed-${trackNum}`);
        if (speedSpan) {
          speedSpan.style.color = '#ffff00';
          speedSpan.style.textShadow = '0 0 5px #ffff00';
        }
        
        const bpmInput = document.getElementById(`bpm-${trackNum}`);
        if (bpmInput) {
          bpmInput.dataset.originalValue = bpmInput.value;
          bpmInput.value = Math.round(targetBPM);
          bpmInput.style.color = '#ffff00';
          bpmInput.style.textShadow = '0 0 5px #ffff00';
          bpmInput.style.borderColor = '#ffff00';
        }
      });
      
      syncBtn.addEventListener('mouseleave', () => {
        const target = tracks[trackNum];
        updateKnobUI(trackNum, 'speed', (target.speedVal || 1.0) * 100);
        
        const speedSpan = document.getElementById(`val-speed-${trackNum}`);
        if (speedSpan) {
          speedSpan.style.color = '';
          speedSpan.style.textShadow = '';
        }
        
        const bpmInput = document.getElementById(`bpm-${trackNum}`);
        if (bpmInput && bpmInput.dataset.originalValue !== undefined) {
          bpmInput.value = bpmInput.dataset.originalValue;
          bpmInput.style.color = '';
          bpmInput.style.textShadow = '';
          bpmInput.style.borderColor = '';
          delete bpmInput.dataset.originalValue;
        }
      });
    }

    // End Sync button: left-click arms the transition, right-click configures it.
    const endSyncBtn = document.getElementById(`btn-end-sync-${trackNum}`);
    if (endSyncBtn) {
      endSyncBtn.addEventListener('click', () => {
        toggleEndSync(trackNum);
      });
      endSyncBtn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openEndSyncSettings(trackNum);
      });
      endSyncBtn.addEventListener('dragover', (event) => {
        if (!Array.from(event.dataTransfer.types || []).includes('application/x-notomixer-cue')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        endSyncBtn.classList.add('cue-dragover');
      });
      endSyncBtn.addEventListener('dragleave', () => {
        endSyncBtn.classList.remove('cue-dragover');
      });
      endSyncBtn.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        endSyncBtn.classList.remove('cue-dragover');
        try {
          const cueData = JSON.parse(
            event.dataTransfer.getData('application/x-notomixer-cue')
          );
          assignCueToEndSync(trackNum, Number(cueData.trackNum), Number(cueData.cueIndex));
        } catch (error) {
          logConsole('End Sync: Invalid cue drop', 'err');
        }
      });
    }

    // Quantize button
    const quantizeBtn = document.getElementById(`btn-quantize-${trackNum}`);
    if (quantizeBtn) {
      quantizeBtn.addEventListener('click', () => {
        tracks[trackNum].quantizeEnabled = !tracks[trackNum].quantizeEnabled;
        if (tracks[trackNum].quantizeEnabled) {
          quantizeBtn.classList.add('active');
        } else {
          quantizeBtn.classList.remove('active');
        }
      });
    }

    // Fallback LOAD DIR button (wrapped in safe check)
    const loadBtn = document.getElementById(`btn-load-${trackNum}`);
    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        ipcRenderer.send('open-directory-dialog', trackNum);
      });
    }

    // Keyboard Volume Input change
    const volInput = document.getElementById(`vol-${trackNum}`);
    volInput.addEventListener('change', (e) => {
      let val = parseInt(e.target.value);
      if (isNaN(val)) val = 80;
      setVolume(trackNum, val);
    });
    volInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        volInput.blur();
      }
    });

    // Progress bar scrubbing (click and drag)
    const progHit = document.getElementById(`prog-hit-${trackNum}`);
    const progContainer = document.getElementById(`prog-container-${trackNum}`);
    let isScrubbing = false;

    function handleScrub(clientX) {
      const rect = progHit.getBoundingClientRect();
      const clickX = clientX - rect.left;
      const percent = Math.max(0, Math.min(100, (clickX / rect.width) * 100));
      seekTrack(trackNum, percent);
    }

    progHit.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      if (progContainer) progContainer.classList.add('scrubbing');
      handleScrub(e.clientX);
      
      window.addEventListener('mousemove', onScrubMove);
      window.addEventListener('mouseup', onScrubUp);
      e.preventDefault(); // Prevent text highlight/selection
    });

    function onScrubMove(e) {
      if (isScrubbing) {
        handleScrub(e.clientX);
      }
    }

    function onScrubUp() {
      if (isScrubbing) {
        isScrubbing = false;
        if (progContainer) progContainer.classList.remove('scrubbing');
        window.removeEventListener('mousemove', onScrubMove);
        window.removeEventListener('mouseup', onScrubUp);
      }
    }

    // Visualizer Mode Buttons
    ['spectrum', 'waveform'].forEach(mode => {
      const btn = document.getElementById(`btn-vis-${mode}-${trackNum}`);
      if (btn) {
        btn.addEventListener('click', () => {
          if (mode === 'spectrum' && !notoMixerConfig.enableSpectrum) return;
          tracks[trackNum].visMode = mode;
          
          // Toggle active class among buttons in this track's header
          ['spectrum', 'waveform'].forEach(m => {
            const b = document.getElementById(`btn-vis-${m}-${trackNum}`);
            if (b) {
              if (m === mode) b.classList.add('active');
              else b.classList.remove('active');
            }
          });
        });
      }
    });

    // EQ Knobs input listeners (Bass, Lows, Treble)
    ['bass', 'low', 'treb'].forEach(param => {
      const slider = document.getElementById(`${param}-${trackNum}`);
      slider.addEventListener('input', (e) => {
        setEQ(trackNum, param, parseFloat(e.target.value));
      });
      updateKnobUI(trackNum, param, 0);
    });

    // Stems EQ Knobs (Inst, Vocals)
    const stemParams = {
      'inst': 'inst',
      'voc': 'vocals'
    };

    Object.keys(stemParams).forEach(param => {
      const stemKey = stemParams[param];
      const slider = document.getElementById(`${param}-${trackNum}`);
      slider.addEventListener('input', (e) => {
        setStemVolume(trackNum, stemKey, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, param, 100);
    });

    // Pitch, Speed, Echo knobs input listeners
    const pitchSlider = document.getElementById(`pitch-${trackNum}`);
    pitchSlider.addEventListener('input', (e) => {
      setPitch(trackNum, parseFloat(e.target.value));
    });
    updateKnobUI(trackNum, 'pitch', 0);

    const speedSlider = document.getElementById(`speed-${trackNum}`);
    speedSlider.addEventListener('input', (e) => {
      setSpeed(trackNum, parseInt(e.target.value));
    });
    updateKnobUI(trackNum, 'speed', 100);

    const echoSlider = document.getElementById(`echo-${trackNum}`);
    echoSlider.addEventListener('input', (e) => {
      setEcho(trackNum, parseInt(e.target.value));
    });
    updateKnobUI(trackNum, 'echo', 0);

    const filterSlider = document.getElementById(`filter-${trackNum}`);
    if (filterSlider) {
      filterSlider.addEventListener('input', (e) => {
        setFilter(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'filter', 50);
    }

    const panSlider = document.getElementById(`pan-${trackNum}`);
    if (panSlider) {
      panSlider.addEventListener('input', (e) => {
        setPan(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'pan', 0);
    }

    const reverbSlider = document.getElementById(`reverb-${trackNum}`);
    if (reverbSlider) {
      reverbSlider.addEventListener('input', (e) => {
        setReverb(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'reverb', 0);
    }

    const echotimeSlider = document.getElementById(`echotime-${trackNum}`);
    if (echotimeSlider) {
      echotimeSlider.addEventListener('input', (e) => {
        setEchoTime(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'echotime', 350);
    }

    // BPM and Metronome listeners
    const bpmInput = document.getElementById(`bpm-${trackNum}`);
    if (bpmInput) {
      bpmInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) val = 120;
        setBPM(trackNum, val);
      });
      bpmInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          bpmInput.blur();
        }
      });
    }

    const bpmdivSelect = document.getElementById(`bpmdiv-${trackNum}`);
    if (bpmdivSelect) {
      bpmdivSelect.addEventListener('change', (e) => {
        setBPMDiv(trackNum, e.target.value);
      });
    }

    const metroBtn = document.getElementById(`btn-metro-${trackNum}`);
    if (metroBtn) {
      metroBtn.addEventListener('click', () => {
        toggleMetronome(trackNum);
      });
    }

    const tapBtn = document.getElementById(`btn-tap-${trackNum}`);
    if (tapBtn) {
      tapBtn.addEventListener('click', () => {
        tapTrackTempo(trackNum);
      });
    }

    // Register Drag & Drop Dropzone behaviors on track strips
    const trackStrip = document.getElementById(`track-${trackNum}`);
    
    trackStrip.addEventListener('dragover', (e) => {
      e.preventDefault();
      trackStrip.classList.add('dragover');
    });

    trackStrip.addEventListener('dragleave', () => {
      trackStrip.classList.remove('dragover');
    });

    trackStrip.addEventListener('drop', (e) => {
      e.preventDefault();
      trackStrip.classList.remove('dragover');
      
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const filePath = getDroppedFilePath(file);
        if (filePath) {
          loadDirectoryStems(trackNum, filePath);
        } else {
          logConsole('Err: Unable to resolve the dropped file path', 'err');
        }
      } else {
        const folderName = e.dataTransfer.getData('text/plain');
        if (folderName && workingDir) {
          const fullPath = path.join(workingDir, folderName);
          loadDirectoryStems(trackNum, fullPath);
        }
      }
    });

    // Setup events for static stems (main and vocals)
    const stems = tracks[trackNum].stems;
    ['main', 'vocals'].forEach(key => {
      const stem = stems[key];
      
      stem.audio.addEventListener('timeupdate', () => {
        let firstActiveAudio = null;
        if (tracks[trackNum].stems.main.exists) firstActiveAudio = tracks[trackNum].stems.main.audio;
        else if (tracks[trackNum].stems.vocals.exists) firstActiveAudio = tracks[trackNum].stems.vocals.audio;
        else if (tracks[trackNum].stems.inst.audios.length > 0) firstActiveAudio = tracks[trackNum].stems.inst.audios[0].audio;
        
        if (firstActiveAudio === stem.audio) {
          handleTrackProgress(trackNum);
        }
      });

      stem.audio.addEventListener('durationchange', () => {
        let firstActiveAudio = null;
        if (tracks[trackNum].stems.main.exists) firstActiveAudio = tracks[trackNum].stems.main.audio;
        else if (tracks[trackNum].stems.vocals.exists) firstActiveAudio = tracks[trackNum].stems.vocals.audio;
        else if (tracks[trackNum].stems.inst.audios.length > 0) firstActiveAudio = tracks[trackNum].stems.inst.audios[0].audio;
        
        if (firstActiveAudio === stem.audio) {
          document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(stem.audio.duration);
        }
      });

      stem.audio.addEventListener('ended', () => {
        let firstActiveAudio = null;
        if (tracks[trackNum].stems.main.exists) firstActiveAudio = tracks[trackNum].stems.main.audio;
        else if (tracks[trackNum].stems.vocals.exists) firstActiveAudio = tracks[trackNum].stems.vocals.audio;
        else if (tracks[trackNum].stems.inst.audios.length > 0) firstActiveAudio = tracks[trackNum].stems.inst.audios[0].audio;
        
        if (firstActiveAudio === stem.audio) {
          handleTrackEnded(trackNum);
        }
      });
    });

    // Track tab switches
    const tabButtons = document.querySelectorAll(`.track-tab-btn[data-track="${trackNum}"]`);
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        document
          .querySelectorAll(`#track-${trackNum} .track-tab-content`)
          .forEach(content => content.classList.remove('active'));
        
        const targetTab = btn.getAttribute('data-tab');
        document
          .getElementById(`track-content-${targetTab}-${trackNum}`)
          ?.classList.add('active');
      });
    });

    // Drag, Drop, and Click for track-specific sampler buttons
    for (let btnIdx = 0; btnIdx < 8; btnIdx++) {
      const cell = document.getElementById(`sound-btn-cell-${trackNum}-${btnIdx}`);
      const btn = document.getElementById(`sound-btn-${trackNum}-${btnIdx}`);
      if (!cell || !btn) continue;
      
      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.add('dragover');
      });
      
      cell.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.remove('dragover');
      });
      
      cell.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const file = files[0];
          const filePath = getDroppedFilePath(file);
          const fileName = file.name || path.basename(filePath);

          if (!filePath) {
            logConsole('Err: Unable to resolve the dropped audio file path', 'err');
            return;
          }
          
          const ext = path.extname(filePath).toLowerCase();
          const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
          if (!audioExtensions.includes(ext)) {
            logConsole(`Err: File dropped is not a supported audio format: ${fileName}`, 'err');
            return;
          }
          
          try {
            initAudio(trackNum);
            btn.textContent = "LOADING...";
            btn.classList.remove('empty-sound-btn');
            
            const audioBuffer = await decodeAudioFile(audioCtx, filePath);
            stopTrackSampleEffect(trackNum, btnIdx);
            tracks[trackNum].soundButtons[btnIdx] = {
              path: filePath,
              name: fileName,
              buffer: audioBuffer
            };

            btn.textContent = fileName.toUpperCase();
            btn.classList.add('loaded');
            btn.style.color = ''; // Reset inline color
            btn.style.borderColor = ''; // Reset inline border color
            btn.title = `${filePath} — right-click for effect settings; middle-click to stop`;
            
            // Also clear any hot cue for this slot
            tracks[trackNum].hotCues[btnIdx] = null;
            clearEndSyncCueAssignmentsForCue(trackNum, btnIdx);
            btn.draggable = false;
            btn.classList.remove('cue-draggable');
            logConsole(`Success: Loaded sample '${fileName}' into Track ${trackNum} button ${btnIdx + 1}`, 'system');
          } catch (readErr) {
            btn.textContent = "DECODE ERR";
            logConsole(`Err: Failed to decode file '${fileName}': ${readErr.message}`, 'err');
          }
        }
      });
      
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const track = tracks[trackNum];
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        else if (track.isSynth && track.fallbackAudio) refAudio = track.fallbackAudio;
        
        if (refAudio && refAudio.duration) {
          const cueTime = refAudio.currentTime;
          track.hotCues[btnIdx] = cueTime;
          const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
          const cueColor = hotCueColors[btnIdx % hotCueColors.length];
          stopTrackSampleEffect(trackNum, btnIdx);
          track.soundButtons[btnIdx] = { path: '', name: 'CUE', buffer: null };
          
          renderHotCueButtonLabel(btn, btnIdx, cueTime);
          btn.classList.add('loaded');
          btn.classList.add('cue-draggable');
          btn.draggable = true;
          btn.style.color = cueColor; // Special color for cues
          btn.style.borderColor = cueColor; // Outline color matches the cue color
          btn.title =
            `Cue ${btnIdx + 1} at ${formatTime(cueTime)} — drag onto the other track's ES button`;
          logConsole(`Success: Set Hot Cue ${btnIdx + 1} at ${cueTime.toFixed(2)}s on Track ${trackNum}`, 'system');
        } else {
          logConsole(`Err: Cannot set cue, no audio playing on Track ${trackNum}`, 'err');
        }
      });

      btn.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          return;
        }
        if (e.button !== 0) return; // Only left click for play/hold
        
        const track = tracks[trackNum];
        const cueTime = track.hotCues[btnIdx];
        
        if (cueTime !== null) {
          const mode = track.cueModes[btnIdx] || 'play';
          if (mode === 'hold') {
            activateTrackHotCue(trackNum, btnIdx, btn, mode);
          }
        } else {
          // It's a Sample (or empty)
          const soundData = track.soundButtons[btnIdx];
          if (soundData && soundData.buffer) {
            playTrackSampleEffect(trackNum, btnIdx, btn);
          } else {
            logConsole(`Info: Button ${btnIdx + 1} is empty. Drag & drop an audio file, right-click to set Hot Cue, or middle-click for settings.`, 'system');
          }
        }
      });

      btn.addEventListener('click', () => {
        const track = tracks[trackNum];
        if (!Number.isFinite(track.hotCues[btnIdx])) return;
        const mode = track.cueModes[btnIdx] || 'play';
        if (mode === 'play') {
          activateTrackHotCue(trackNum, btnIdx, btn, mode);
        }
      });
      
      const releaseHold = (e) => {
        if (e.button !== 0) return;
        if (btn.classList.contains('holding')) {
          btn.classList.remove('holding');
          btn.classList.remove('playing');
          
          const track = tracks[trackNum];
          const returnTime = parseFloat(btn.dataset.holdReturnTime);
          const wasPlaying = btn.dataset.holdWasPlaying === 'true';
          track.activeHoldCueIdx = null;
          
          if (!isNaN(returnTime)) {
            if (track.stems.main.exists) track.stems.main.audio.currentTime = returnTime;
            if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = returnTime;
            track.stems.inst.audios.forEach(item => item.audio.currentTime = returnTime);
            if (track.isSynth && track.fallbackAudio) track.fallbackAudio.currentTime = returnTime;
            handleTrackProgress(trackNum);
          }
          
          if (!wasPlaying && track.isPlaying) {
             pauseTrack(trackNum);
          }
        }
      };
      
      btn.addEventListener('mouseup', releaseHold);
      btn.addEventListener('mouseleave', releaseHold);

      btn.addEventListener('dragstart', (event) => {
        const cueTime = tracks[trackNum].hotCues[btnIdx];
        if (!Number.isFinite(cueTime)) {
          event.preventDefault();
          return;
        }
        if (btn.classList.contains('holding')) {
          releaseHold({ button: 0 });
        }
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData(
          'application/x-notomixer-cue',
          JSON.stringify({ trackNum, cueIndex: btnIdx })
        );
        btn.classList.add('cue-dragging');
      });

      btn.addEventListener('dragend', () => {
        btn.classList.remove('cue-dragging');
        document.querySelectorAll('.btn-end-sync.cue-dragover').forEach(button => {
          button.classList.remove('cue-dragover');
        });
      });
      
      btn.addEventListener('auxclick', (e) => {
        if (e.button === 1) { // Middle click
          e.preventDefault();
          const track = tracks[trackNum];
          if (track.hotCues[btnIdx] !== null) {
            openCueSettings(trackNum, btnIdx);
          } else if (track.soundButtons[btnIdx]?.buffer) {
            stopTrackSampleEffect(trackNum, btnIdx, { logStop: true });
          } else {
            logConsole(`Info: Button ${btnIdx + 1} is empty.`, 'system');
          }
        }
      });
    }

    // Hook up canvas scratching
    const canvas = document.getElementById(`canvas-${trackNum}`);
    if (canvas) {
      setupCanvasScratching(trackNum, canvas);
    }

    const overviewCanvas = document.getElementById(`overview-canvas-${trackNum}`);
    if (overviewCanvas) {
      overviewCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const track = tracks[trackNum];
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        else if (track.isSynth && track.fallbackAudio) refAudio = track.fallbackAudio;
        
        if (!refAudio || isNaN(refAudio.duration)) return;
        
        const scrub = (moveEvent) => {
          const rect = overviewCanvas.getBoundingClientRect();
          const clickX = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
          const pct = clickX / rect.width;
          const newTime = pct * refAudio.duration;
          
          if (track.stems.main.exists) track.stems.main.audio.currentTime = newTime;
          if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = newTime;
          track.stems.inst.audios.forEach(item => item.audio.currentTime = newTime);
          if (track.isSynth && track.fallbackAudio) track.fallbackAudio.currentTime = newTime;
          handleTrackProgress(trackNum);
        };
        
        scrub(e);
        
        const onMove = (moveEvent) => scrub(moveEvent);
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (tracks[1].syncEnabled) performBeatSync(1);
          if (tracks[2].syncEnabled) performBeatSync(2);
        };
        
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    }

    // Editable Time Current
    const timeCurrentEl = document.getElementById(`time-current-${trackNum}`);
    if (timeCurrentEl) {
      const applyTimeEdit = () => {
        const text = timeCurrentEl.textContent.trim();
        let newTime = 0;
        if (text.includes(':')) {
          const parts = text.split(':');
          if (parts.length === 2) {
            newTime = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
          } else if (parts.length === 3) {
            newTime = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
          }
        } else {
          newTime = parseFloat(text);
        }
        
        const track = tracks[trackNum];
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        else if (track.isSynth && track.fallbackAudio) refAudio = track.fallbackAudio;
        
        if (!isNaN(newTime) && newTime >= 0 && refAudio) {
          // Clamp to duration
          newTime = Math.min(newTime, refAudio.duration || newTime);
          
          if (track.stems.main.exists) track.stems.main.audio.currentTime = newTime;
          if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = newTime;
          track.stems.inst.audios.forEach(item => item.audio.currentTime = newTime);
          if (track.isSynth && track.fallbackAudio) track.fallbackAudio.currentTime = newTime;
          handleTrackProgress(trackNum);
        } else {
          if (refAudio) {
            timeCurrentEl.textContent = formatTime(refAudio.currentTime);
          }
        }
        timeCurrentEl.blur();
      };
      
      timeCurrentEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyTimeEdit();
        }
      });
      timeCurrentEl.addEventListener('blur', applyTimeEdit);
      timeCurrentEl.addEventListener('focus', () => {
        setTimeout(() => document.execCommand('selectAll', false, null), 50);
      });
    }

    // Loop control UI bindings
    const btnAutoLoop = document.getElementById(`btn-auto-loop-${trackNum}`);
    const btnHalve = document.getElementById(`btn-loop-halve-${trackNum}`);
    const btnDouble = document.getElementById(`btn-loop-double-${trackNum}`);
    const displayLoop = document.getElementById(`loop-display-${trackNum}`);
    const btnLoopIn = document.getElementById(`btn-loop-in-${trackNum}`);
    const btnLoopOut = document.getElementById(`btn-loop-out-${trackNum}`);
    const btnLoopExit = document.getElementById(`btn-loop-exit-${trackNum}`);
    const btnLoopRepeat = document.getElementById(`btn-loop-repeat-${trackNum}`);
    const btnLoopRestart = document.getElementById(`btn-loop-restart-${trackNum}`);
    
    const loopOptions = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
    let selectedOptionIndex = 6; // default 4 BEATS
    
    function updateLoopDisplay() {
      const beats = loopOptions[selectedOptionIndex];
      tracks[trackNum].autoLoopBeats = beats;
      if (beats < 1) {
        if (beats === 0.0625) displayLoop.textContent = "1/16";
        else if (beats === 0.125) displayLoop.textContent = "1/8";
        else if (beats === 0.25) displayLoop.textContent = "1/4";
        else if (beats === 0.5) displayLoop.textContent = "1/2";
      } else {
        displayLoop.textContent = beats.toString();
      }
    }
    
    if (btnHalve && btnDouble && displayLoop) {
      btnHalve.addEventListener('click', () => {
        if (selectedOptionIndex > 0) {
          selectedOptionIndex--;
          updateLoopDisplay();
          if (tracks[trackNum].loopEnabled) {
            triggerAutoLoop(trackNum);
          }
        }
      });
      btnDouble.addEventListener('click', () => {
        if (selectedOptionIndex < loopOptions.length - 1) {
          selectedOptionIndex++;
          updateLoopDisplay();
          if (tracks[trackNum].loopEnabled) {
            triggerAutoLoop(trackNum);
          }
        }
      });
    }
    
    if (btnAutoLoop) {
      btnAutoLoop.addEventListener('click', () => {
        const track = tracks[trackNum];
        if (track.loopEnabled) {
          track.loopEnabled = false;
          track.loopStartTime = null;
          track.loopEndTime = null;
          btnAutoLoop.classList.remove('active');
          btnAutoLoop.textContent = "AUTO LOOP OFF";
          if (btnLoopIn) btnLoopIn.classList.remove('active');
          if (btnLoopOut) btnLoopOut.classList.remove('active');
          updateMusicEndingWarning(trackNum);
        } else {
          triggerAutoLoop(trackNum);
        }
      });
    }
    
    function triggerAutoLoop(tNum) {
      const track = tracks[tNum];
      quantizeAction(tNum, () => {
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        
        if (!refAudio || isNaN(refAudio.duration)) return;
        
        const bpm = track.bpmVal || 120;
        const beatDuration = 60 / bpm;
        const loopDuration = track.autoLoopBeats * beatDuration;
        
        if (track.loopStartTime === null) {
          track.loopStartTime = track.quantizeEnabled 
            ? snapTimeToBeat(tNum, refAudio.currentTime, 'nearest') 
            : refAudio.currentTime;
        }
        track.loopEndTime = track.loopStartTime + loopDuration;
        
        if (track.loopEndTime > refAudio.duration) {
          track.loopEndTime = refAudio.duration;
          track.loopStartTime = Math.max(0, track.loopEndTime - loopDuration);
        }
        
        track.loopEnabled = true;
        if (btnAutoLoop) {
          btnAutoLoop.classList.add('active');
          btnAutoLoop.textContent = `AUTO LOOP ON`;
        }
        if (btnLoopIn) btnLoopIn.classList.add('active');
        if (btnLoopOut) btnLoopOut.classList.add('active');
        updateMusicEndingWarning(tNum);
      }, 'Auto Loop');
    }
    
    if (btnLoopIn) {
      btnLoopIn.addEventListener('click', () => {
        quantizeAction(trackNum, () => {
          const track = tracks[trackNum];
          let refAudio = null;
          if (track.stems.main.exists) refAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
          
          if (!refAudio || isNaN(refAudio.duration)) return;
          
          track.loopStartTime = track.quantizeEnabled 
            ? snapTimeToBeat(trackNum, refAudio.currentTime, 'nearest') 
            : refAudio.currentTime;
          btnLoopIn.classList.add('active');
          
          if (track.loopEndTime !== null && track.loopEndTime > track.loopStartTime) {
            track.loopEnabled = true;
            if (btnLoopOut) btnLoopOut.classList.add('active');
            updateMusicEndingWarning(trackNum);
          }
        }, 'Loop In');
      });
    }
    
    if (btnLoopOut) {
      btnLoopOut.addEventListener('click', () => {
        quantizeAction(trackNum, () => {
          const track = tracks[trackNum];
          let refAudio = null;
          if (track.stems.main.exists) refAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
          
          if (!refAudio || isNaN(refAudio.duration)) return;
          
          if (track.loopStartTime === null) {
            track.loopStartTime = track.quantizeEnabled ? snapTimeToBeat(trackNum, 0, 'nearest') : 0;
            if (btnLoopIn) btnLoopIn.classList.add('active');
          }
          
          track.loopEndTime = track.quantizeEnabled
            ? snapTimeToBeat(trackNum, refAudio.currentTime, 'nearest')
            : refAudio.currentTime;
            
          if (track.loopEndTime <= track.loopStartTime) {
            track.loopEndTime = track.loopStartTime + 1;
          }
          
          track.loopEnabled = true;
          btnLoopOut.classList.add('active');
          updateMusicEndingWarning(trackNum);
        }, 'Loop Out');
      });
    }
    
    if (btnLoopExit) {
      btnLoopExit.addEventListener('click', () => {
        const track = tracks[trackNum];
        track.loopEnabled = false;
        track.loopStartTime = null;
        track.loopEndTime = null;
        if (btnAutoLoop) {
          btnAutoLoop.classList.remove('active');
          btnAutoLoop.textContent = "AUTO LOOP OFF";
        }
        if (btnLoopIn) btnLoopIn.classList.remove('active');
        if (btnLoopOut) btnLoopOut.classList.remove('active');
        updateMusicEndingWarning(trackNum);
      });
    }

    if (btnLoopRepeat) {
      btnLoopRepeat.addEventListener('click', () => {
        const track = tracks[trackNum];
        track.loopRepeatEnabled = !track.loopRepeatEnabled;
        btnLoopRepeat.classList.toggle('active', track.loopRepeatEnabled);
        btnLoopRepeat.setAttribute('aria-pressed', track.loopRepeatEnabled ? 'true' : 'false');
      });
    }

    if (btnLoopRestart) {
      btnLoopRestart.addEventListener('click', () => restartTrackLoop(trackNum));
    }
  });

  // Console toggle
  const consoleHeader = document.getElementById('console-toggle');
  consoleHeader.addEventListener('click', () => {
    document.querySelector('.exertia-console').classList.toggle('collapsed');
  });


  
  // Choose working directory click
  document.getElementById('btn-set-working-dir').addEventListener('click', () => {
    ipcRenderer.send('select-working-directory');
  });

  // Resizable bottom explorer logic
  const resizeHandle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.querySelector('.exertia-sidebar');
  if (resizeHandle && sidebar) {
    let isResizing = false;
    
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      resizeHandle.classList.add('active');
      
      const startY = e.clientY;
      const startHeight = sidebar.clientHeight;
      
      function onMouseMove(moveEvent) {
        if (!isResizing) return;
        
        // Bottom explorer: dragging upward increases its height.
        const deltaY = startY - moveEvent.clientY;
        const newHeight = startHeight + deltaY;
        if (newHeight >= 100 && newHeight <= 450) {
          sidebar.style.height = newHeight + 'px';
          localStorage.setItem('notoMixer_explorerHeight', newHeight);
        }
      }
      
      function onMouseUp() {
        isResizing = false;
        resizeHandle.classList.remove('active');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        persistUserSettings();
      }
      
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // Resizable Stacked Visualizer logic
  const stackedHandle = document.getElementById('stacked-resize-handle');
  const stackedArea = document.getElementById('stacked-visualizer-area');
  if (stackedHandle && stackedArea) {
    let isResizingStacked = false;
    
    stackedHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizingStacked = true;
      stackedHandle.classList.add('active');
      
      const startYStacked = e.clientY;
      const startHeightStacked = stackedArea.clientHeight;
      
      function onMouseMoveStacked(moveEvent) {
        if (!isResizingStacked) return;
        const deltaY = moveEvent.clientY - startYStacked;
        const newHeight = startHeightStacked + deltaY;
        if (newHeight >= 100 && newHeight <= 800) {
          stackedArea.style.height = newHeight + 'px';
          localStorage.setItem('notoMixer_stackedHeight', newHeight);
        }
      }
      
      function onMouseUpStacked() {
        isResizingStacked = false;
        stackedHandle.classList.remove('active');
        window.removeEventListener('mousemove', onMouseMoveStacked);
        window.removeEventListener('mouseup', onMouseUpStacked);
        persistUserSettings();
      }
      
      window.addEventListener('mousemove', onMouseMoveStacked);
      window.addEventListener('mouseup', onMouseUpStacked);
    });
  }
}

function reverseAudioBuffer(buffer, audioCtx) {
  if (!buffer) return null;
  const numChannels = buffer.numberOfChannels;
  const numFrames = buffer.length;
  const sampleRate = buffer.sampleRate;
  
  const reversed = audioCtx.createBuffer(numChannels, numFrames, sampleRate);
  
  for (let c = 0; c < numChannels; c++) {
    const srcData = buffer.getChannelData(c);
    const destData = reversed.getChannelData(c);
    for (let i = 0; i < numFrames; i++) {
      destData[i] = srcData[numFrames - 1 - i];
    }
  }
  return reversed;
}

// -------------------------------------------------------------
// Song Directory Loading System & Sync
// -------------------------------------------------------------

async function loadDirectoryStems(trackNum, dirPath) {
  try {
    const track = tracks[trackNum];
    const directoryLoadToken = (track._directoryLoadToken || 0) + 1;
    track._directoryLoadToken = directoryLoadToken;
    stopTrack(trackNum); // Force stop channel
    clearEndSyncCueAssignmentsForTarget(trackNum);
    clearTrackHotCues(trackNum);
    
    track.dirPath = dirPath;
    updateTrackPlatterCover(trackNum);
    track.silenceStartTime = 0;
    track.silenceEndTime = null;
    track.silenceAnalysisReady = false;
    
    // Check if path is a file
    let isFile = false;
    let actualDirPath = dirPath;
    try {
      const stats = fs.statSync(dirPath);
      isFile = stats.isFile();
    } catch (err) {}

    let mainFile = '';
    let vocalsFile = '';
    const instFiles = [];
    let songTitle = '';

    if (isFile) {
      actualDirPath = path.dirname(dirPath);
      mainFile = path.basename(dirPath);
      songTitle = path.basename(dirPath, path.extname(dirPath));
    } else {
      songTitle = dirPath.split(/[\\/]/).pop();
    }

    track.title = songTitle.toUpperCase();
    document.getElementById(`track-name-${trackNum}`).textContent = track.title;
    // Clean up any dynamic inst audio elements first
    track.stems.inst.audios.forEach(item => {
      item.audio.pause();
      item.audio.src = '';
      item.audio.remove(); // Remove from DOM to release resources
      if (item.source) item.source.disconnect();
    });
    track.stems.inst.audios = [];
    track.stems.inst.exists = false;

    if (!isFile) {
      // Read files inside directory
      const files = fs.readdirSync(dirPath);
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
      
      files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (audioExtensions.includes(ext)) {
          const name = path.basename(file, ext).toLowerCase();
          if (name === 'main') {
            mainFile = file;
          } else if (name === 'vocals') {
            vocalsFile = file;
          } else {
            instFiles.push(file);
          }
        }
      });

      // If we don't have main/vocals and only have exactly 1 audio file, treat it as main
      if (!mainFile && !vocalsFile && instFiles.length === 1) {
        mainFile = instFiles.pop();
      }
    }

    const originalAudioPaths = [];
    if (mainFile) originalAudioPaths.push(path.join(actualDirPath, mainFile));
    if (vocalsFile) originalAudioPaths.push(path.join(actualDirPath, vocalsFile));
    instFiles.forEach(file => originalAudioPaths.push(path.join(actualDirPath, file)));
    if (originalAudioPaths.some(isM4aFile)) {
      logConsole(`M4A: Checking codec compatibility for Track ${trackNum}...`, 'system');
    }
    const compatibleAudioPaths = await getCompatibleAudioPaths(originalAudioPaths);
    if (track._directoryLoadToken !== directoryLoadToken) return;
    const convertedM4aCount = originalAudioPaths.filter(
      originalPath => compatibleAudioPaths.get(originalPath) !== originalPath
    ).length;
    if (convertedM4aCount > 0) {
      logConsole(`M4A: Lossless compatibility cache ready for Track ${trackNum}.`, 'system');
    }
    const getPlayablePath = originalPath => (
      compatibleAudioPaths.get(originalPath) || originalPath
    );

    let hasAtLeastOneFile = false;
    initAudio(trackNum); // Ensure context exists

    // Load main stem (main.mp3)
    const mainIndicator = document.getElementById(`ind-main-${trackNum}`);
    const mainCell = document.getElementById(`cell-main-${trackNum}`);
    track.staticWaveform = null; // Clear old static waveform
    if (mainFile) {
      const originalFilePath = path.join(actualDirPath, mainFile);
      const filePath = getPlayablePath(originalFilePath);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      track.stems.main.audio.src = URL.createObjectURL(blob);
      track.stems.main.audio.preservesPitch = false;
      track.stems.main.audio.playbackRate = track.speedVal;
      track.stems.main.audio.load();
      track.stems.main.exists = true;
      hasAtLeastOneFile = true;
      
      // Lazily create and connect source node after src is set
      if (!track.stems.main.source && track.stems.main.gainNode) {
        track.stems.main.source = audioCtx.createMediaElementSource(track.stems.main.audio);
        track.stems.main.source.connect(track.stems.main.gainNode);
      }
      
      if (mainIndicator) mainIndicator.classList.add('present');
      if (mainCell) mainCell.classList.remove('disabled');
      logConsole(`Main Stem loaded: Track ${trackNum} -> ${mainFile}`, 'system');
    } else {
      track.stems.main.audio.src = '';
      track.stems.main.exists = false;
      if (mainIndicator) mainIndicator.classList.remove('present');
      if (mainCell) mainCell.classList.add('disabled');
      logConsole(`Main Stem missing: Track ${trackNum}`, 'system');
    }

    // Load vocals stem (vocals.mp3)
    const vocalsIndicator = document.getElementById(`ind-vocals-${trackNum}`);
    const vocalsCell = document.getElementById(`cell-voc-${trackNum}`);
    if (vocalsFile) {
      const originalFilePath = path.join(actualDirPath, vocalsFile);
      const filePath = getPlayablePath(originalFilePath);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      track.stems.vocals.audio.src = URL.createObjectURL(blob);
      track.stems.vocals.audio.preservesPitch = false;
      track.stems.vocals.audio.playbackRate = track.speedVal;
      track.stems.vocals.audio.load();
      track.stems.vocals.exists = true;
      hasAtLeastOneFile = true;
      
      // Lazily create and connect source node after src is set
      if (!track.stems.vocals.source && track.stems.vocals.gainNode) {
        track.stems.vocals.source = audioCtx.createMediaElementSource(track.stems.vocals.audio);
        track.stems.vocals.source.connect(track.stems.vocals.gainNode);
      }

      vocalsIndicator.classList.add('present');
      vocalsCell.classList.remove('disabled');
      logConsole(`Vocals Stem loaded: Track ${trackNum} -> ${vocalsFile}`, 'system');
    } else {
      track.stems.vocals.audio.src = '';
      track.stems.vocals.exists = false;
      vocalsIndicator.classList.remove('present');
      vocalsCell.classList.add('disabled');
      logConsole(`Vocals Stem missing: Track ${trackNum} (EQ VOCALS disabled)`, 'system');
    }

    // Load all remaining files as instrumental stems (Dynamic Multi-Stem INST)
    const instIndicator = document.getElementById(`ind-inst-${trackNum}`);
    const instCell = document.getElementById(`cell-inst-${trackNum}`);
    
    if (instFiles.length > 0) {
      instFiles.forEach(file => {
        const originalFilePath = path.join(actualDirPath, file);
        const filePath = getPlayablePath(originalFilePath);
        const data = fs.readFileSync(filePath);
        const mimeType = getMimeType(filePath);
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const audio = new Audio();
        audio.src = url;
        audio.style.display = 'none';
        document.body.appendChild(audio); // Append to DOM to prevent Chromium silence bug
        audio.preservesPitch = false;
        audio.playbackRate = track.speedVal;
        audio.load();
        
        const source = audioCtx.createMediaElementSource(audio);
        
        // Connect to static inst gain node
        if (track.stems.inst.gainNode) {
          source.connect(track.stems.inst.gainNode);
        }
        
        // Set up event listeners for this dynamic instrumental audio element
        audio.addEventListener('timeupdate', () => {
          let firstActiveAudio = null;
          if (track.stems.main.exists) firstActiveAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) firstActiveAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) firstActiveAudio = track.stems.inst.audios[0].audio;
          
          if (firstActiveAudio === audio) {
            handleTrackProgress(trackNum);
          }
        });

        audio.addEventListener('durationchange', () => {
          let firstActiveAudio = null;
          if (track.stems.main.exists) firstActiveAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) firstActiveAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) firstActiveAudio = track.stems.inst.audios[0].audio;
          
          if (firstActiveAudio === audio) {
            document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(audio.duration);
          }
        });

        audio.addEventListener('ended', () => {
          let firstActiveAudio = null;
          if (track.stems.main.exists) firstActiveAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) firstActiveAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) firstActiveAudio = track.stems.inst.audios[0].audio;
          
          if (firstActiveAudio === audio) {
            handleTrackEnded(trackNum);
          }
        });

        track.stems.inst.audios.push({
          audio,
          source,
          gainNode: null,
          file
        });
        hasAtLeastOneFile = true;
        logConsole(`Instrumental Stem loaded: Track ${trackNum} -> ${file}`, 'system');
      });
      
      track.stems.inst.exists = true;
      instIndicator.classList.add('present');
      instCell.classList.remove('disabled');
      logConsole(`Success: Loaded ${instFiles.length} instrumental stems in Track ${trackNum}`, 'system');
    } else {
      track.stems.inst.exists = false;
      instIndicator.classList.remove('present');
      instCell.classList.add('disabled');
      logConsole(`Instrumental Stem absent: Track ${trackNum} (EQ INST disabled)`, 'system');
    }

    // Playback must wait until Chromium has decoded enough media data. Without
    // this gate, a fast Play press can race the load() calls above and leave
    // the deck visually playing while every media element is still stalled.
    prepareTrackMediaReadiness(trackNum);

    // Generate combined static waveform for all loaded stems
    track.staticWaveform = null; // Clear old waveform
    const pathsToDecode = [];
    if (mainFile) pathsToDecode.push(path.join(actualDirPath, mainFile));
    if (vocalsFile) pathsToDecode.push(path.join(actualDirPath, vocalsFile));
    instFiles.forEach(file => pathsToDecode.push(path.join(actualDirPath, file)));

    if (pathsToDecode.length > 0) {
      const verifiedAnalysis = verifiedSongAnalysis.get(getSongAnalysisKey(pathsToDecode[0]));
      if (verifiedAnalysis) {
        applySongAnalysisToTrack(trackNum, verifiedAnalysis);
        logConsole(
          `NotoMixer Song Analyzer Daemon: instant BPM/waveform loaded on Track ${trackNum}`,
          'system'
        );
      }

      logConsole(`Waveform: Starting combined decode for ${pathsToDecode.length} files...`, 'system');
      const decodePromises = pathsToDecode.map(filePath => (
        decodeAudioFile(audioCtx, filePath).catch(err => {
          logConsole(`Warning Waveform: Unable to decode ${path.basename(filePath)}: ${err.message}`, 'err');
          return null;
        })
      ));

      Promise.all(decodePromises).then(buffers => {
        // Associate decoded buffers with stems for real-time scratching
        let bufIdx = 0;
        if (mainFile && buffers[bufIdx]) {
          track.stems.main.buffer = buffers[bufIdx];
          track.stems.main.reversedBuffer = reverseAudioBuffer(buffers[bufIdx], audioCtx);
          bufIdx++;
        }
        if (vocalsFile && buffers[bufIdx]) {
          track.stems.vocals.buffer = buffers[bufIdx];
          track.stems.vocals.reversedBuffer = reverseAudioBuffer(buffers[bufIdx], audioCtx);
          bufIdx++;
        }
        instFiles.forEach(file => {
          if (buffers[bufIdx]) {
            const instAudio = track.stems.inst.audios.find(item => item.file === file);
            if (instAudio) {
              instAudio.buffer = buffers[bufIdx];
              instAudio.reversedBuffer = reverseAudioBuffer(buffers[bufIdx], audioCtx);
            }
            bufIdx++;
          }
        });

        const audioBuffers = buffers.filter(buf => buf !== null);
        if (audioBuffers.length === 0) return;

        const silenceBounds = detectSilenceBoundaries(audioBuffers);
        track.silenceStartTime = silenceBounds.start;
        track.silenceEndTime = silenceBounds.end;
        track.silenceAnalysisReady = true;

        const openingSilence = silenceBounds.start;
        const endingSilence = Math.max(
          0,
          Math.max(...audioBuffers.map(buffer => buffer.duration)) - silenceBounds.end
        );
        logConsole(
          `Music: Track ${trackNum} silence detected (start ${openingSilence.toFixed(2)}s, end ${endingSilence.toFixed(2)}s)`,
          'system'
        );
        if (track.isPlaying) {
          skipOpeningSilenceIfNeeded(trackNum);
          updateMusicEndingWarning(trackNum);
        }

        // Auto-analyze BPM (Rekordbox-style)
        try {
          logConsole(`BPM: Analyzing tempo for Track ${trackNum}...`, 'system');
          
          let detectedBpm = 120;
          let detectedOffset = 0;
          
          // Use only cache data whose MD5 was verified during this app session.
          const mainAudioPath = pathsToDecode[0];
          const verifiedMeta = verifiedSongAnalysis.get(getSongAnalysisKey(mainAudioPath));
          let gotCache = false;
          
          if (verifiedMeta) {
            detectedBpm = verifiedMeta.bpm;
            detectedOffset = verifiedMeta.offset || 0;
            gotCache = true;
            logConsole(`BPM: Loaded MD5-verified ${detectedBpm} BPM and ${detectedOffset.toFixed(3)}s offset for Track ${trackNum}`, 'system');
          }
          
          if (!gotCache) {
            detectedBpm = estimateBPM(audioBuffers[0]);
            detectedOffset = estimateBeatOffset(audioBuffers[0], detectedBpm);
            logConsole(`BPM: Analyzed ${detectedBpm} BPM and ${detectedOffset.toFixed(3)}s offset for Track ${trackNum}`, 'system');
          }
          
          track.beatOffset = detectedOffset;
          setBPM(trackNum, detectedBpm);
        } catch (bpmErr) {
          console.error("BPM analysis error:", bpmErr);
        }

        const numPeaks = 2000;
        const maxDuration = Math.max(...audioBuffers.map(buf => buf.duration));
        const peaks = new Float32Array(numPeaks);

        audioBuffers.forEach(buf => {
          const rawData = buf.getChannelData(0);
          const L = rawData.length;
          const SR = buf.sampleRate;
          const duration = buf.duration;

          for (let i = 0; i < numPeaks; i++) {
            const startTime = (i / numPeaks) * maxDuration;
            const endTime = ((i + 1) / numPeaks) * maxDuration;

            if (startTime < duration) {
              const startIdx = Math.floor(startTime * SR);
              const endIdx = Math.min(L, Math.floor(endTime * SR));
              if (endIdx > startIdx) {
                let sum = 0;
                for (let j = startIdx; j < endIdx; j++) {
                  sum += Math.abs(rawData[j]);
                }
                peaks[i] += sum / (endIdx - startIdx);
              }
            }
          }
        });

        const maxVal = Math.max(...peaks);
        track.staticWaveform = Array.from(peaks).map(p => p / (maxVal || 1));
        if (!verifiedAnalysis) animateTrackWaveform(trackNum);
        logConsole(`Waveform: Track ${trackNum} decoded successfully (${audioBuffers.length} stems combined).`, 'system');
      }).catch(err => {
        logConsole(`Err Waveform: Combined decode failed on Track ${trackNum}: ${err.message}`, 'err');
      });
    }

    // Re-enable effects that might have been disabled by the test track
    ['filter', 'pitch', 'speed', 'echo', 'reverb', 'echotime'].forEach(key => {
      const cell = document.getElementById(`cell-${key}-${trackNum}`);
      if (cell) cell.classList.remove('disabled');
    });

    const bpmInput = document.getElementById(`bpm-${trackNum}`);
    if (bpmInput && bpmInput.parentElement && bpmInput.parentElement.parentElement) {
      bpmInput.parentElement.parentElement.classList.remove('disabled-control');
    }
    
    const bpmDiv = document.getElementById(`bpmdiv-${trackNum}`);
    if (bpmDiv && bpmDiv.parentElement) {
      bpmDiv.parentElement.classList.remove('disabled-control');
    }
    
    const metroBtn = document.getElementById(`btn-metro-${trackNum}`);
    if (metroBtn && metroBtn.parentElement) {
      metroBtn.parentElement.classList.remove('disabled-control');
    }

    const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
    if (syncBtn) syncBtn.classList.remove('disabled-control');

    const endSyncBtn = document.getElementById(`btn-end-sync-${trackNum}`);
    if (endSyncBtn) endSyncBtn.classList.remove('disabled-control');
    
    const quantizeBtn = document.getElementById(`btn-quantize-${trackNum}`);
    if (quantizeBtn) quantizeBtn.classList.remove('disabled-control');

    if (hasAtLeastOneFile) {
      logConsole(`Success: Song loaded on Channel ${trackNum} -> ${songTitle}`, 'system');
    } else {
      logConsole(`Warning: No valid audio file found in ${songTitle}`, 'err');
    }
    updateEndSyncMissingTargetAlert(trackNum, true);
    updateEndSyncMissingTargetAlert(trackNum === 1 ? 2 : 1, true);
  } catch (err) {
    logConsole(`Err: Folder load failed: ${err.message}`, 'err');
  }
}

// Fallback folder loader from IPC
ipcRenderer.on('directory-selected', (event, { trackNum, dirPath }) => {
  loadDirectoryStems(trackNum, dirPath);
});

// BPM Filter / Compatibility Indicator
let bpmFilterTrack = 1; // 1 or 2, which track to compare against
let currentStatusFilter = 'ALL'; // 'ALL', '✓', '⚠', '✗'
let currentSearchQuery = '';
let currentPlaylistFilter = '';
let songAnalyzerGeneration = 0;
const songAnalyzerPendingJobs = [];
let songAnalyzerActiveJobs = 0;

const songAnalyzerLogicalCoreCount = Math.max(
  1,
  typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length
);
const songAnalyzerCpuWorkerLimit = Math.max(1, songAnalyzerLogicalCoreCount - 1);
const songAnalyzerMemoryWorkerLimit = Math.max(
  1,
  Math.floor(Math.max(0, os.totalmem() - (2 * 1024 ** 3)) / (768 * 1024 ** 2))
);
const SONG_ANALYZER_WORKER_COUNT = Math.max(
  1,
  Math.min(songAnalyzerCpuWorkerLimit, songAnalyzerMemoryWorkerLimit)
);
let songAnalysisWorkerPool = null;
let portableSongAnalysisCache = null;
let portableSongAnalysisCacheRoot = '';
const verifiedSongAnalysis = new Map();
let songAnalyzerUiState = {
  generation: 0,
  total: 0,
  completed: 0,
  failed: 0,
  current: '',
  startedAt: 0
};

function setSongAnalyzerUiText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function beginSongAnalyzerDaemon(total, generation) {
  songAnalyzerUiState = {
    generation,
    total,
    completed: 0,
    failed: 0,
    current: total === 1 ? '1 song queued' : `${total} songs queued`,
    startedAt: Date.now()
  };

  const overlay = document.getElementById('song-analyzer-daemon');
  if (overlay) {
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
  }
  setSongAnalyzerUiText('song-analyzer-percent', '0%');

  const progress = document.getElementById('song-analyzer-progress');
  const fill = document.getElementById('song-analyzer-progress-fill');
  if (progress) progress.setAttribute('aria-valuenow', '0');
  if (fill) fill.style.width = '0%';
  publishTabletControllerState(true);
}

function setSongAnalyzerActiveSong(generation, songName) {
  if (generation !== songAnalyzerUiState.generation) return;
  songAnalyzerUiState.current = songName;
  publishTabletControllerState(true);
}

function settleSongAnalyzerItem(generation, songName, failed = false) {
  if (generation !== songAnalyzerUiState.generation) return;
  songAnalyzerUiState.completed += 1;
  if (failed) songAnalyzerUiState.failed += 1;
  songAnalyzerUiState.current = failed ? `${songName} — analysis failed` : `${songName} — ready`;

  const { completed, total } = songAnalyzerUiState;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 100;
  setSongAnalyzerUiText('song-analyzer-percent', `${percentage}%`);

  const progress = document.getElementById('song-analyzer-progress');
  const fill = document.getElementById('song-analyzer-progress-fill');
  if (progress) progress.setAttribute('aria-valuenow', String(percentage));
  if (fill) fill.style.width = `${percentage}%`;
  publishTabletControllerState(true);
}

function closeSongAnalyzerDaemon(generation, failed = 0, immediate = false) {
  if (generation !== songAnalyzerUiState.generation) return;
  const overlay = document.getElementById('song-analyzer-daemon');
  const elapsed = Date.now() - songAnalyzerUiState.startedAt;
  const finishDelay = immediate ? 0 : Math.max(260, 600 - elapsed);

  window.setTimeout(() => {
    if (generation !== songAnalyzerUiState.generation) return;
    if (overlay) {
      overlay.classList.remove('show');
      overlay.setAttribute('aria-hidden', 'true');
    }
    initialSongCheckComplete = true;
    publishTabletControllerState(true);
    maybeShowEvaluationNotice();
  }, finishDelay);
}

function releaseInitialSongAnalyzerGate() {
  const generation = ++songAnalyzerGeneration;
  songAnalyzerUiState = {
    generation,
    total: 0,
    completed: 0,
    failed: 0,
    current: '',
    startedAt: Date.now()
  };
  closeSongAnalyzerDaemon(generation, 0, true);
}

function animateTrackWaveform(trackNum) {
  const canvases = [
    document.getElementById(`overview-canvas-${trackNum}`),
    document.getElementById(`canvas-${trackNum}`)
  ].filter(Boolean);

  if (notoMixerConfig.legacyMode) {
    canvases.forEach(canvas => canvas.classList.remove('waveform-reveal'));
    return;
  }

  canvases.forEach(canvas => {
    canvas.classList.remove('waveform-reveal');
    void canvas.offsetWidth;
    canvas.classList.add('waveform-reveal');
    canvas.addEventListener('animationend', () => {
      canvas.classList.remove('waveform-reveal');
    }, { once: true });
  });
}

const NOTOMIXER_STEM_FILE_NAMES = new Set([
  'main',
  'vocals',
  'vocal',
  'instrumental',
  'instrumentals',
  'inst',
  'accompaniment',
  'bass',
  'drums',
  'guitar',
  'keys',
  'other',
  'percussion',
  'piano',
  'strings',
  'synth'
]);

function discoverSongLibrary() {
  const entries = fs.readdirSync(workingDir, { withFileTypes: true });
  const songs = [];
  const playlists = [];

  entries.forEach(entry => {
    if (entry.name.toLowerCase() === '.notomixer') return;
    const entryPath = path.join(workingDir, entry.name);
    if (entry.isFile()) {
      if (SONG_AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        songs.push({
          displayName: entry.name,
          relativePath: entry.name,
          playlist: ''
        });
      }
      return;
    }
    if (!entry.isDirectory()) return;

    let childAudioFiles = [];
    try {
      childAudioFiles = fs.readdirSync(entryPath, { withFileTypes: true })
        .filter(child => (
          child.isFile()
          && SONG_AUDIO_EXTENSIONS.has(path.extname(child.name).toLowerCase())
        ))
        .map(child => child.name);
    } catch (error) {
      // Preserve the old behavior for unreadable directories: keep them in
      // the library and let the analyzer report that they cannot be read.
      songs.push({
        displayName: entry.name,
        relativePath: entry.name,
        playlist: ''
      });
      return;
    }

    const isStemSong = childAudioFiles.some(fileName => (
      NOTOMIXER_STEM_FILE_NAMES.has(
        path.basename(fileName, path.extname(fileName)).toLowerCase()
      )
    ));

    if (childAudioFiles.length > 0 && !isStemSong) {
      playlists.push(entry.name);
      childAudioFiles.forEach(fileName => {
        songs.push({
          displayName: fileName,
          relativePath: path.join(entry.name, fileName),
          playlist: entry.name
        });
      });
      return;
    }

    // A folder containing main/vocals/etc. remains one NotoMixer multi-stem
    // song. Empty folders are also retained for backwards compatibility.
    songs.push({
      displayName: entry.name,
      relativePath: entry.name,
      playlist: ''
    });
  });

  songs.sort((a, b) => (
    a.displayName.localeCompare(b.displayName)
    || a.relativePath.localeCompare(b.relativePath)
  ));
  playlists.sort((a, b) => a.localeCompare(b));
  return { songs, playlists };
}

function renderPlaylistNavigation(playlists) {
  const playlistList = document.getElementById('playlist-folder-list');
  if (!playlistList) return;

  if (
    currentPlaylistFilter !== ''
    && !playlists.includes(currentPlaylistFilter)
  ) {
    currentPlaylistFilter = '';
  }

  playlistList.innerHTML = '';
  const choices = [
    { id: '', label: 'SHOW ALL' },
    ...playlists.map(playlist => ({ id: playlist, label: playlist }))
  ];

  choices.forEach(choice => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'playlist-folder-button';
    button.dataset.playlist = choice.id;
    button.classList.toggle('active', choice.id === currentPlaylistFilter);
    button.setAttribute(
      'aria-pressed',
      choice.id === currentPlaylistFilter ? 'true' : 'false'
    );

    const icon = document.createElement('span');
    icon.className = 'playlist-folder-icon';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = choice.label;
    button.appendChild(icon);
    button.appendChild(label);

    button.addEventListener('click', () => {
      currentPlaylistFilter = choice.id;
      playlistList.querySelectorAll('.playlist-folder-button').forEach(item => {
        const active = item.dataset.playlist === currentPlaylistFilter;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      applySongListFilters();
    });
    playlistList.appendChild(button);
  });
}

function applySongListFilters() {
  const songsList = document.getElementById('songs-list');
  if (!songsList) return;

  const items = Array.from(songsList.querySelectorAll('li[data-folder]'));
  const emptyPlaceholder = document.getElementById('song-filter-empty');
  if (items.length === 0) return;

  const query = currentSearchQuery.toLowerCase();

  // 1. Filter by selected playlist and search query.
  let visibleCount = 0;
  items.forEach(li => {
    const matchesPlaylist = currentPlaylistFilter === ''
      || li.dataset.playlist === currentPlaylistFilter;
    const matchesSearch = (li.dataset.searchText || li.dataset.folder || '')
      .toLowerCase()
      .includes(query);
    const visible = matchesPlaylist && matchesSearch;
    li.style.display = visible ? 'flex' : 'none';
    if (visible) visibleCount += 1;
  });

  // 2. Sort by status
  if (currentStatusFilter !== 'ALL') {
    items.sort((a, b) => {
      const iconA = a.querySelector('.bpm-compat-icon');
      const iconB = b.querySelector('.bpm-compat-icon');
      
      const charA = iconA ? iconA.textContent : '';
      const charB = iconB ? iconB.textContent : '';
      
      const aMatches = (charA === currentStatusFilter) ? 1 : 0;
      const bMatches = (charB === currentStatusFilter) ? 1 : 0;
      
      // Matchers bubble to the top
      return bMatches - aMatches;
    });
    
    // Re-append in new order
    items.forEach(li => songsList.appendChild(li));
  } else {
    // Revert to alphabetical sort
    items.sort((a, b) => {
      const nameA = (a.dataset.songName || a.dataset.folder || '').toLowerCase();
      const nameB = (b.dataset.songName || b.dataset.folder || '').toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
    items.forEach(li => songsList.appendChild(li));
  }

  if (emptyPlaceholder) {
    emptyPlaceholder.hidden = visibleCount > 0;
    emptyPlaceholder.textContent = query
      ? 'No songs match this search'
      : 'No songs in this playlist';
    songsList.appendChild(emptyPlaceholder);
  }
}

function updateBpmCompatIndicators() {
  const songsList = document.getElementById('songs-list');
  if (!songsList) return;

  const refTrack = tracks[bpmFilterTrack];
  const refBpm = refTrack ? refTrack.bpmVal : null;
  const filterBtn = document.getElementById('btn-bpm-filter');

  const items = songsList.querySelectorAll('li[data-bpm]');
  items.forEach(li => {
    const icon = li.querySelector('.bpm-compat-icon');
    if (!icon) return;

    const songBpm = parseFloat(li.dataset.bpm);
    if (!songBpm || isNaN(songBpm) || !refBpm) {
      icon.className = 'bpm-compat-icon unknown';
      icon.textContent = '·';
      return;
    }

    const diff = Math.abs(songBpm - refBpm);

    if (diff <= 5) {
      // Match - checkmark in the track's color
      icon.className = bpmFilterTrack === 1 ? 'bpm-compat-icon match' : 'bpm-compat-icon match-t2';
      icon.textContent = '✓';
    } else if (diff <= 20) {
      // Warning - within 20 BPM
      icon.className = 'bpm-compat-icon warn';
      icon.textContent = '⚠';
    } else {
      // Far - more than 20 BPM
      icon.className = 'bpm-compat-icon far';
      icon.textContent = '✗';
    }
  });
  
  // Re-apply filters whenever BPM compatibility updates
  applySongListFilters();
}

function isWorkingDirectoryAvailable() {
  if (!workingDir) return false;
  try {
    return fs.statSync(workingDir).isDirectory();
  } catch (error) {
    return false;
  }
}

function updateWorkingDirectoryLabel() {
  const pathLabel = document.getElementById('working-dir-path');
  if (pathLabel) pathLabel.textContent = workingDir;
  const headerTitle = document.getElementById('songs-header-title');
  if (headerTitle) {
    headerTitle.textContent = workingDir
      ? `AVAILABLE SONGS (${workingDir})`
      : 'AVAILABLE SONGS';
  }
}

function renderMediaSupportAvailability(isRemoved) {
  const songsGroup = document.querySelector('.explorer-songs-group');
  const alert = document.getElementById('media-support-removed-alert');
  songsGroup?.classList.toggle('media-support-removed', isRemoved);
  if (alert) {
    alert.hidden = !isRemoved;
    alert.setAttribute('aria-hidden', isRemoved ? 'false' : 'true');
  }
}

function resetSongAnalyzerForUnavailableSupport() {
  const generation = ++songAnalyzerGeneration;
  while (songAnalyzerPendingJobs.length > 0) {
    songAnalyzerPendingJobs.shift().resolve(null);
  }
  songAnalyzerUiState = {
    generation,
    total: 0,
    completed: 0,
    failed: 0,
    current: '',
    startedAt: Date.now()
  };
  closeSongAnalyzerDaemon(generation, 0, true);
}

function handleWorkingDirectoryUnavailable({ logChange = true } = {}) {
  const stateChanged = workingDirectoryAvailable !== false;
  workingDirectoryAvailable = false;
  currentPlaylistFilter = '';
  updateWorkingDirectoryLabel();
  renderPlaylistNavigation([]);
  renderMediaSupportAvailability(true);

  const songsList = document.getElementById('songs-list');
  if (songsList) songsList.innerHTML = '';

  resetSongAnalyzerForUnavailableSupport();
  publishTabletSongLibrary();
  publishTabletControllerState(true);

  if (stateChanged && logChange) {
    logConsole(`Explorer: USB media support removed or unavailable (${workingDir})`, 'err');
  }
}

function handleWorkingDirectoryAvailable({ logChange = true } = {}) {
  const reconnected = workingDirectoryAvailable === false;
  workingDirectoryAvailable = true;
  updateWorkingDirectoryLabel();
  renderMediaSupportAvailability(false);

  if (reconnected && logChange) {
    logConsole(`Explorer: USB media support reconnected (${workingDir})`, 'system');
  }

  scanWorkingDirectory();
}

function refreshWorkingDirectoryAvailability(options = {}) {
  if (!workingDir) return;
  const availableNow = isWorkingDirectoryAvailable();
  if (availableNow === workingDirectoryAvailable) return;
  if (availableNow) {
    handleWorkingDirectoryAvailable(options);
  } else {
    handleWorkingDirectoryUnavailable(options);
  }
}

function startWorkingDirectoryMonitor() {
  if (workingDirectoryMonitorId !== null) {
    window.clearInterval(workingDirectoryMonitorId);
  }
  workingDirectoryMonitorId = window.setInterval(() => {
    refreshWorkingDirectoryAvailability();
  }, WORKING_DIRECTORY_MONITOR_INTERVAL_MS);
}

function scanWorkingDirectory() {
  const songsList = document.getElementById('songs-list');
  if (!songsList) return;
  const analyzerGeneration = ++songAnalyzerGeneration;
  const analysisJobs = [];

  songsList.innerHTML = '';

  if (!workingDir) {
    currentPlaylistFilter = '';
    renderPlaylistNavigation([]);
    songsList.innerHTML = '<li class="song-list-placeholder">No folder selected</li>';
    songAnalyzerUiState = {
      generation: analyzerGeneration,
      total: 0,
      completed: 0,
      failed: 0,
      current: '',
      startedAt: Date.now()
    };
    closeSongAnalyzerDaemon(analyzerGeneration, 0, true);
    publishTabletSongLibrary();
    return;
  }

  if (!isWorkingDirectoryAvailable()) {
    handleWorkingDirectoryUnavailable();
    return;
  }
  workingDirectoryAvailable = true;
  renderMediaSupportAvailability(false);
  loadPortableSongAnalysisCache();

  try {
    const { songs: songItems, playlists } = discoverSongLibrary();
    renderPlaylistNavigation(playlists);

    if (songItems.length === 0) {
      songsList.innerHTML = '<li class="song-list-placeholder">No songs or folders found</li>';
      songAnalyzerUiState = {
        generation: analyzerGeneration,
        total: 0,
        completed: 0,
        failed: 0,
        current: '',
        startedAt: Date.now()
      };
      closeSongAnalyzerDaemon(analyzerGeneration, 0, true);
      publishTabletSongLibrary();
      return;
    }

    beginSongAnalyzerDaemon(songItems.length, analyzerGeneration);

    const emptyPlaceholder = document.createElement('li');
    emptyPlaceholder.id = 'song-filter-empty';
    emptyPlaceholder.className = 'song-list-placeholder';
    emptyPlaceholder.textContent =
      'Verified songs will appear here as they become available';
    songsList.appendChild(emptyPlaceholder);

    songItems.forEach(songItem => {
      const songPath = path.join(workingDir, songItem.relativePath);
      const li = document.createElement('li');
      li.setAttribute('draggable', 'true');
      li.dataset.folder = songItem.relativePath;
      li.dataset.songName = songItem.displayName;
      li.dataset.playlist = songItem.playlist;
      li.dataset.searchText = `${songItem.displayName} ${songItem.playlist}`.trim();
      li.title = songItem.playlist
        ? `${songItem.playlist} / ${songItem.displayName}`
        : songItem.displayName;

      // 1. Artwork thumbnail
      const artDiv = document.createElement('div');
      artDiv.className = 'song-item-art';
      const artImg = document.createElement('img');
      artImg.className = 'song-art-img';

      // Try to find cover art inside song folder
      let artSrc = DEFAULT_COVER_ART_URI;
      let coverPath = '';
      try {
        const sStats = fs.statSync(songPath);
        if (sStats.isDirectory()) {
          const sFiles = fs.readdirSync(songPath);
          const imgFile = sFiles.find(file => {
            const ext = path.extname(file).toLowerCase();
            const nameLc = path.basename(file, ext).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext) &&
                   (nameLc.includes('cover') || nameLc.includes('art') || nameLc.includes('folder') || nameLc.includes('thumb') || nameLc.includes('artwork'));
          });
          if (imgFile) {
            coverPath = path.join(songPath, imgFile);
            artSrc = coverPath;
          }
        }
      } catch (err) {}
      artImg.src = artSrc;
      li.dataset.coverPath = coverPath;
      artDiv.appendChild(artImg);
      li.appendChild(artDiv);

      // 2. Mini Preview Waveform Canvas
      const waveCanvas = document.createElement('canvas');
      waveCanvas.className = 'song-item-wave-canvas';
      waveCanvas.width = 140;
      waveCanvas.height = 22;
      li.appendChild(waveCanvas);

      // Initial flat waveform line placeholder
      const wCtx = waveCanvas.getContext('2d');
      wCtx.fillStyle = '#333';
      wCtx.fillRect(0, 10, 140, 2);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'song-item-name';
      nameSpan.textContent = songItem.displayName;
      li.appendChild(nameSpan);

      const metaDiv = document.createElement('div');
      metaDiv.className = 'song-item-meta';

      const bpmCompatIcon = document.createElement('span');
      bpmCompatIcon.className = 'bpm-compat-icon unknown';
      bpmCompatIcon.textContent = '·';

      const bpmSpan = document.createElement('span');
      bpmSpan.className = 'song-item-bpm';
      bpmSpan.textContent = '-- BPM';

      const keySpan = document.createElement('span');
      keySpan.className = 'song-item-key';
      keySpan.textContent = '--';

      const durSpan = document.createElement('span');
      durSpan.className = 'song-item-duration';
      durSpan.textContent = '--:--';

      metaDiv.appendChild(bpmCompatIcon);
      metaDiv.appendChild(keySpan);
      metaDiv.appendChild(bpmSpan);
      metaDiv.appendChild(durSpan);
      li.appendChild(metaDiv);

      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', songItem.relativePath);
        e.dataTransfer.effectAllowed = 'copy';
      });

      // Middle click to open preview window
      li.addEventListener('auxclick', (e) => {
        if (e.button === 1) { // 1 is middle click
          e.preventDefault();
          loadPreviewSong(songPath, songItem.displayName);
        }
      });

      // Prevent middle click auto-scrolling cursor from appearing
      li.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
        }
      });

      // Queue verification and reveal this row only when the song is usable.
      const analysisJob = loadSongMetadata(
        songPath,
        keySpan,
        bpmSpan,
        durSpan,
        waveCanvas,
        artImg,
        analyzerGeneration
      );
      const revealSong = () => {
        if (analyzerGeneration !== songAnalyzerGeneration) return;
        songsList.insertBefore(li, emptyPlaceholder);
        updateBpmCompatIndicators();
        publishTabletSongLibrary();
      };
      analysisJobs.push(
        analysisJob.then(
          result => {
            revealSong();
            return result;
          },
          error => {
            revealSong();
            throw error;
          }
        )
      );
    });
    publishTabletSongLibrary();

    logConsole(
      `Explorer: Found ${songItems.length} songs in ${playlists.length} playlists/folders in ${workingDir}`,
      'system'
    );
    logConsole(`NotoMixer Song Analyzer Daemon: checking ${songItems.length} USB manifests and MD5 hashes`, 'system');
    Promise.allSettled(analysisJobs).then(results => {
      if (analyzerGeneration !== songAnalyzerGeneration) return;
      const failed = results.filter(result => result.status === 'rejected').length;
      logConsole(
        `NotoMixer Song Analyzer Daemon: complete (${results.length - failed} ready, ${failed} failed)`,
        failed > 0 ? 'err' : 'system'
      );
      closeSongAnalyzerDaemon(analyzerGeneration, failed);
    });
  } catch (err) {
    logConsole(`Err Explorer: Folder read failed: ${err.message}`, 'err');
    if (!isWorkingDirectoryAvailable()) {
      handleWorkingDirectoryUnavailable();
      return;
    }
    currentPlaylistFilter = '';
    renderPlaylistNavigation([]);
    songsList.innerHTML = `<li class="song-list-placeholder text-red">Read error</li>`;
    songAnalyzerUiState = {
      generation: analyzerGeneration,
      total: 0,
      completed: 0,
      failed: 1,
      current: 'Music library read error',
      startedAt: Date.now()
    };
    closeSongAnalyzerDaemon(analyzerGeneration, 1);
    publishTabletSongLibrary();
  }
}

function drawSongMiniWaveform(waveCanvas, peaks) {
  if (!waveCanvas) return;
  const ctx = waveCanvas.getContext('2d');
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  ctx.clearRect(0, 0, w, h);
  
  if (!peaks || peaks.length === 0) {
    ctx.fillStyle = '#333';
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }
  
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0055ff');
  grad.addColorStop(0.5, '#00ffff');
  grad.addColorStop(1, '#0055ff');
  ctx.fillStyle = grad;
  
  const barWidth = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i];
    const valH = Math.max(1, peak * h * 0.9);
    const x = i * barWidth;
    const y = (h - valH) / 2;
    ctx.fillRect(x, y, barWidth - 0.5, valH);
  }
}

const SONG_ANALYSIS_CACHE_VERSION = 2;
const SONG_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a']);
const PORTABLE_SONG_CACHE_FORMAT = 'notomixer-portable-analysis';
const PORTABLE_SONG_CACHE_VERSION = 1;
const PORTABLE_SONG_CACHE_DIR = '.notomixer';
const PORTABLE_SONG_CACHE_FILE = 'library-cache-v1.json';

function createEmptyPortableSongAnalysisCache() {
  return {
    format: PORTABLE_SONG_CACHE_FORMAT,
    version: PORTABLE_SONG_CACHE_VERSION,
    analyzerVersion: SONG_ANALYSIS_CACHE_VERSION,
    updatedAt: Date.now(),
    songs: {}
  };
}

function getPortableSongCachePaths(rootPath = workingDir) {
  const cacheDirectory = path.join(rootPath, PORTABLE_SONG_CACHE_DIR);
  const cacheFile = path.join(cacheDirectory, PORTABLE_SONG_CACHE_FILE);
  return {
    cacheDirectory,
    cacheFile,
    backupFile: `${cacheFile}.bak`,
    artworkDirectory: path.join(cacheDirectory, 'artwork')
  };
}

function normalizePortableRelativePath(filePath) {
  if (!workingDir || !filePath) return '';
  const relativePath = path.relative(path.resolve(workingDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return '';
  }
  return relativePath.split(path.sep).join('/');
}

function resolvePortableRelativePath(relativePath) {
  if (!workingDir || typeof relativePath !== 'string' || !relativePath) return '';
  const normalized = relativePath.replace(/\//g, path.sep);
  const resolved = path.resolve(workingDir, normalized);
  const relativeCheck = path.relative(path.resolve(workingDir), resolved);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) return '';
  return resolved;
}

function getPortableSongCacheKey(songPath) {
  const relativePath = normalizePortableRelativePath(songPath);
  return relativePath ? `song:${relativePath}` : '';
}

function isPortableSongCacheDocument(value) {
  return Boolean(
    value &&
    value.format === PORTABLE_SONG_CACHE_FORMAT &&
    value.version === PORTABLE_SONG_CACHE_VERSION &&
    value.analyzerVersion === SONG_ANALYSIS_CACHE_VERSION &&
    value.songs &&
    typeof value.songs === 'object' &&
    !Array.isArray(value.songs)
  );
}

function loadPortableSongAnalysisCache() {
  portableSongAnalysisCacheRoot = workingDir ? path.resolve(workingDir) : '';
  portableSongAnalysisCache = createEmptyPortableSongAnalysisCache();
  verifiedSongAnalysis.clear();
  if (!portableSongAnalysisCacheRoot) return portableSongAnalysisCache;

  const { cacheFile, backupFile } = getPortableSongCachePaths(
    portableSongAnalysisCacheRoot
  );
  for (const candidatePath of [cacheFile, backupFile]) {
    if (!fs.existsSync(candidatePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      if (!isPortableSongCacheDocument(parsed)) {
        throw new Error('unsupported or invalid cache format');
      }
      portableSongAnalysisCache = parsed;
      logConsole(
        `NotoMixer Song Analyzer Daemon: portable USB cache loaded (${Object.keys(parsed.songs).length} songs)`,
        'system'
      );
      return portableSongAnalysisCache;
    } catch (error) {
      console.warn(`Unable to read portable song cache ${candidatePath}:`, error);
    }
  }
  return portableSongAnalysisCache;
}

function persistPortableSongAnalysisCache() {
  if (
    !portableSongAnalysisCacheRoot ||
    path.resolve(workingDir || '') !== portableSongAnalysisCacheRoot ||
    !portableSongAnalysisCache
  ) {
    return false;
  }

  const { cacheDirectory, cacheFile, backupFile } = getPortableSongCachePaths(
    portableSongAnalysisCacheRoot
  );
  const temporaryFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    portableSongAnalysisCache.updatedAt = Date.now();
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(portableSongAnalysisCache),
      'utf8'
    );
    if (fs.existsSync(cacheFile)) {
      try {
        fs.copyFileSync(cacheFile, backupFile);
      } catch (error) {}
      fs.copyFileSync(temporaryFile, cacheFile);
      fs.unlinkSync(temporaryFile);
    } else {
      fs.renameSync(temporaryFile, cacheFile);
    }
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch (cleanupError) {}
    logConsole(
      `NotoMixer Song Analyzer Daemon: USB cache write failed (${error.message})`,
      'err'
    );
    return false;
  }
}

function buildPortableAudioManifest(audioFiles) {
  return audioFiles.map(filePath => {
    const stats = fs.statSync(filePath);
    return {
      path: normalizePortableRelativePath(filePath),
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs)
    };
  });
}

function portableAudioManifestsMatch(cachedManifest, currentManifest) {
  if (
    !Array.isArray(cachedManifest) ||
    cachedManifest.length !== currentManifest.length
  ) {
    return false;
  }
  return currentManifest.every((file, index) => {
    const cached = cachedManifest[index];
    return cached &&
      cached.path === file.path &&
      cached.size === file.size &&
      cached.mtimeMs === file.mtimeMs;
  });
}

function hydratePortableSongAnalysis(record, songPath, mainAudioPath) {
  const cover = resolvePortableRelativePath(record.coverPath);
  return {
    ...record,
    songPath,
    mainAudioPath,
    cover: cover && fs.existsSync(cover) ? cover : '',
    waveformPeaks: decodeWaveformPeaks(record.waveformData)
  };
}

function getPortableSongAnalysisRecord(songPath) {
  if (!portableSongAnalysisCache) return null;
  const cacheKey = getPortableSongCacheKey(songPath);
  return cacheKey ? portableSongAnalysisCache.songs[cacheKey] || null : null;
}

function storePortableSongAnalysis(songPath, meta, fileManifest) {
  if (!portableSongAnalysisCache) {
    portableSongAnalysisCache = createEmptyPortableSongAnalysisCache();
    portableSongAnalysisCacheRoot = workingDir ? path.resolve(workingDir) : '';
  }
  const cacheKey = getPortableSongCacheKey(songPath);
  if (!cacheKey) return false;

  const waveformData = typeof meta.waveformData === 'string'
    ? meta.waveformData
    : encodeWaveformPeaks(meta.waveformPeaks || []);
  portableSongAnalysisCache.songs[cacheKey] = {
    cacheVersion: SONG_ANALYSIS_CACHE_VERSION,
    md5: meta.md5,
    bpm: meta.bpm,
    key: typeof meta.key === 'string' ? meta.key : '--',
    duration: meta.duration,
    offset: meta.offset || 0,
    peaks: Array.isArray(meta.peaks) ? meta.peaks : [],
    waveformData,
    silenceStart: meta.silenceStart || 0,
    silenceEnd: meta.silenceEnd,
    coverPath: normalizePortableRelativePath(meta.cover),
    analyzedAt: meta.analyzedAt || Date.now(),
    bpmManuallySet: meta.bpmManuallySet === true,
    bpmUpdatedAt: meta.bpmUpdatedAt || 0,
    files: fileManifest
  };
  return persistPortableSongAnalysisCache();
}

function getSongAnalysisKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveSongAnalysisFiles(songPath) {
  const stats = fs.statSync(songPath);
  if (stats.isFile()) {
    if (!SONG_AUDIO_EXTENSIONS.has(path.extname(songPath).toLowerCase())) {
      return { isFile: true, mainAudioPath: '', audioFiles: [] };
    }
    return { isFile: true, mainAudioPath: songPath, audioFiles: [songPath] };
  }

  const audioFiles = fs.readdirSync(songPath)
    .filter(file => SONG_AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map(file => path.join(songPath, file));

  const priority = filePath => {
    const name = path.basename(filePath, path.extname(filePath)).toLowerCase();
    if (name === 'main') return 0;
    if (name === 'vocals') return 1;
    return 2;
  };
  audioFiles.sort((a, b) => {
    const priorityDiff = priority(a) - priority(b);
    return priorityDiff || path.basename(a).localeCompare(path.basename(b));
  });

  return {
    isFile: false,
    mainAudioPath: audioFiles[0] || '',
    audioFiles
  };
}

async function calculateSongMd5(audioFiles) {
  const hash = crypto.createHash('md5');
  for (const filePath of audioFiles) {
    hash.update(path.basename(filePath).toLowerCase());
    hash.update('\0');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    hash.update('\0');
  }
  return hash.digest('hex');
}

function generateCombinedWaveformPeaks(audioBuffers, peakCount) {
  const maxDuration = Math.max(...audioBuffers.map(buffer => buffer.duration));
  const peaks = new Float32Array(peakCount);

  audioBuffers.forEach(buffer => {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    for (let i = 0; i < peakCount; i++) {
      const startTime = (i / peakCount) * maxDuration;
      if (startTime >= buffer.duration) continue;
      const endTime = ((i + 1) / peakCount) * maxDuration;
      const startIndex = Math.floor(startTime * sampleRate);
      const endIndex = Math.min(rawData.length, Math.floor(endTime * sampleRate));
      if (endIndex <= startIndex) continue;

      let sum = 0;
      for (let sample = startIndex; sample < endIndex; sample++) {
        sum += Math.abs(rawData[sample]);
      }
      peaks[i] += sum / (endIndex - startIndex);
    }
  });

  const maxPeak = Math.max(...peaks);
  return Array.from(peaks).map(peak => (
    Math.round((peak / (maxPeak || 1)) * 1000) / 1000
  ));
}

function downsampleWaveformPeaks(peaks, targetCount) {
  const result = new Array(targetCount).fill(0);
  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor((i / targetCount) * peaks.length);
    const end = Math.max(start + 1, Math.floor(((i + 1) / targetCount) * peaks.length));
    for (let j = start; j < end && j < peaks.length; j++) {
      result[i] = Math.max(result[i], peaks[j]);
    }
  }
  return result;
}

function encodeWaveformPeaks(peaks) {
  const quantized = Uint8Array.from(peaks, peak => (
    Math.max(0, Math.min(255, Math.round(peak * 255)))
  ));
  return Buffer.from(quantized).toString('base64');
}

function decodeWaveformPeaks(encoded) {
  const quantized = Buffer.from(encoded, 'base64');
  return Array.from(quantized, value => value / 255);
}

async function findSongCover(songPath, mainAudioPath, isFile) {
  if (!isFile) {
    const imageFile = fs.readdirSync(songPath).find(file => {
      const ext = path.extname(file).toLowerCase();
      const name = path.basename(file, ext).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext)
        && ['cover', 'art', 'folder', 'thumb', 'artwork'].some(token => name.includes(token));
    });
    return imageFile ? path.join(songPath, imageFile) : '';
  }

  try {
    const picture = await ipcRenderer.invoke('audio-metadata:get-cover', mainAudioPath);
    if (!picture?.data) return '';
    const { artworkDirectory } = getPortableSongCachePaths();
    if (!fs.existsSync(artworkDirectory)) {
      fs.mkdirSync(artworkDirectory, { recursive: true });
    }
    const portableIdentity = normalizePortableRelativePath(mainAudioPath);
    const safeName = crypto.createHash('md5').update(portableIdentity).digest('hex') + '.jpg';
    const cachedCoverPath = path.join(artworkDirectory, safeName);
    fs.writeFileSync(cachedCoverPath, Buffer.from(picture.data));
    return cachedCoverPath;
  } catch (error) {
    console.warn(`Cover extraction failed for ${mainAudioPath}:`, error);
    return '';
  }
}

function applySongAnalysisToExplorer(meta, keyElement, bpmElement, durElement, waveCanvas, artImg, generation) {
  if (generation !== songAnalyzerGeneration || !bpmElement) return;
  if (keyElement) keyElement.textContent = meta.key || '--';
  bpmElement.textContent = `${meta.bpm} BPM`;
  durElement.textContent = formatTime(meta.duration);
  const parentLi = bpmElement.closest('li');
  if (parentLi) {
    parentLi.dataset.bpm = meta.bpm;
    parentLi.dataset.key = meta.key || '';
    parentLi.dataset.duration = Number.isFinite(Number(meta.duration))
      ? String(meta.duration)
      : '';
    parentLi.dataset.coverPath = meta.cover && fs.existsSync(meta.cover)
      ? meta.cover
      : '';
  }
  if (waveCanvas && meta.peaks) drawSongMiniWaveform(waveCanvas, meta.peaks);
  if (artImg && meta.cover && fs.existsSync(meta.cover)) artImg.src = meta.cover;
  updateBpmCompatIndicators();
  publishTabletSongLibrary();
}

function applySongAnalysisToTrack(trackNum, meta) {
  const track = tracks[trackNum];
  if (!track || !meta) return;
  updateTrackPlatterCover(trackNum, meta.cover || '');
  track.staticWaveform = Array.isArray(meta.waveformPeaks) ? meta.waveformPeaks.slice() : null;
  track.beatOffset = meta.offset || 0;
  track.silenceStartTime = meta.silenceStart || 0;
  track.silenceEndTime = Number.isFinite(meta.silenceEnd) ? meta.silenceEnd : meta.duration;
  track.silenceAnalysisReady = true;
  setBPM(trackNum, meta.bpm || 120);

  const durationElement = document.getElementById(`time-duration-${trackNum}`);
  if (durationElement) durationElement.textContent = formatTime(meta.duration);
  if (track.staticWaveform && track.staticWaveform.length > 0) animateTrackWaveform(trackNum);
}

function hydrateLoadedTracksFromAnalysis(meta) {
  [1, 2].forEach(trackNum => {
    const trackPath = tracks[trackNum].dirPath;
    if (trackPath && getSongAnalysisKey(trackPath) === getSongAnalysisKey(meta.songPath)) {
      applySongAnalysisToTrack(trackNum, meta);
      logConsole(`NotoMixer Song Analyzer Daemon: hydrated Track ${trackNum} from cache`, 'system');
    }
  });
}

async function analyzeSongMetadata(
  songPath,
  keyElement,
  bpmElement,
  durElement,
  waveCanvas,
  artImg,
  generation
) {
  const { isFile, mainAudioPath, audioFiles } = resolveSongAnalysisFiles(songPath);
  if (!mainAudioPath || audioFiles.length === 0) {
    if (generation === songAnalyzerGeneration && bpmElement) {
      bpmElement.textContent = 'NO AUDIO';
      if (keyElement) keyElement.textContent = '--';
      durElement.textContent = '--:--';
    }
    return null;
  }

  const fileManifest = buildPortableAudioManifest(audioFiles);
  const cachedRecord = getPortableSongAnalysisRecord(songPath);
  const validCachedRecord = Boolean(
    cachedRecord &&
    cachedRecord.cacheVersion === SONG_ANALYSIS_CACHE_VERSION &&
    typeof cachedRecord.md5 === 'string' &&
    typeof cachedRecord.key === 'string' &&
    typeof cachedRecord.waveformData === 'string'
  );
  const manifestMatches = validCachedRecord && portableAudioManifestsMatch(
    cachedRecord.files,
    fileManifest
  );

  const md5 = await calculateSongMd5(audioFiles);
  if (validCachedRecord && cachedRecord.md5 === md5) {
    const cached = hydratePortableSongAnalysis(
      cachedRecord,
      songPath,
      mainAudioPath
    );
    if (!manifestMatches) {
      cached.files = fileManifest;
      storePortableSongAnalysis(songPath, cached, fileManifest);
    }
    verifiedSongAnalysis.set(getSongAnalysisKey(mainAudioPath), cached);
    applySongAnalysisToExplorer(
      cached,
      keyElement,
      bpmElement,
      durElement,
      waveCanvas,
      artImg,
      generation
    );
    hydrateLoadedTracksFromAnalysis(cached);
    logConsole(
      `NotoMixer Song Analyzer Daemon: MD5 verified, reused ${path.basename(songPath)}`,
      'system'
    );
    return cached;
  }

  logConsole(
    `NotoMixer Song Analyzer Daemon: ${cachedRecord ? 'MD5 changed' : 'new song'}, analyzing ${path.basename(songPath)}`,
    'system'
  );
  initPreviewAudio();

  const decodedBuffers = [];
  for (const filePath of audioFiles) {
    decodedBuffers.push(await decodeAudioFile(previewAudioCtx, filePath));
  }

  const {
    duration,
    bpm,
    key,
    offset,
    waveformPeaks,
    peaks,
    silence
  } = await getSongAnalysisWorkerPool().analyze(decodedBuffers);
  const mainStats = fs.statSync(mainAudioPath);
  const cover = await findSongCover(songPath, mainAudioPath, isFile);

  const meta = {
    cacheVersion: SONG_ANALYSIS_CACHE_VERSION,
    md5,
    songPath,
    mainAudioPath,
    bpm,
    key,
    duration,
    offset,
    peaks,
    waveformPeaks,
    silenceStart: silence.start,
    silenceEnd: silence.end,
    mtime: mainStats.mtimeMs,
    size: mainStats.size,
    cover,
    analyzedAt: Date.now()
  };
  const cacheMeta = { ...meta, waveformData: encodeWaveformPeaks(waveformPeaks) };
  delete cacheMeta.waveformPeaks;
  storePortableSongAnalysis(songPath, cacheMeta, fileManifest);
  verifiedSongAnalysis.set(getSongAnalysisKey(mainAudioPath), meta);
  applySongAnalysisToExplorer(meta, keyElement, bpmElement, durElement, waveCanvas, artImg, generation);
  hydrateLoadedTracksFromAnalysis(meta);
  return meta;
}

function drainSongAnalyzerJobs() {
  while (
    songAnalyzerActiveJobs < SONG_ANALYZER_WORKER_COUNT &&
    songAnalyzerPendingJobs.length > 0
  ) {
    const queuedJob = songAnalyzerPendingJobs.shift();
    if (queuedJob.generation !== songAnalyzerGeneration) {
      queuedJob.resolve(null);
      continue;
    }

    songAnalyzerActiveJobs += 1;
    Promise.resolve()
      .then(queuedJob.run)
      .then(queuedJob.resolve, queuedJob.reject)
      .finally(() => {
        songAnalyzerActiveJobs -= 1;
        drainSongAnalyzerJobs();
      });
  }
}

function enqueueSongAnalyzerJob(generation, run) {
  return new Promise((resolve, reject) => {
    songAnalyzerPendingJobs.push({ generation, run, resolve, reject });
    drainSongAnalyzerJobs();
  });
}

function loadSongMetadata(songPath, keyElement, bpmElement, durElement, waveCanvas, artImg, generation) {
  if (bpmElement) bpmElement.textContent = 'QUEUED';
  if (keyElement) keyElement.textContent = '--';
  const songName = path.basename(songPath);
  return enqueueSongAnalyzerJob(generation, () => {
      if (generation !== songAnalyzerGeneration) return null;
      setSongAnalyzerActiveSong(generation, songName);
      return analyzeSongMetadata(
        songPath,
        keyElement,
        bpmElement,
        durElement,
        waveCanvas,
        artImg,
        generation
      );
    })
    .then(result => {
      settleSongAnalyzerItem(generation, songName, false);
      return result;
    })
    .catch(error => {
      console.error(`NotoMixer Song Analyzer Daemon failed for ${songPath}:`, error);
      if (generation === songAnalyzerGeneration && bpmElement) {
        bpmElement.textContent = 'ERR';
        if (keyElement) keyElement.textContent = '--';
      }
      settleSongAnalyzerItem(generation, songName, true);
      throw error;
    });
}

ipcRenderer.on('working-directory-selected', (event, dirPath) => {
  workingDir = dirPath;
  workingDirectoryAvailable = null;
  currentPlaylistFilter = '';
  localStorage.setItem('notoMixer_workingDir', dirPath);
  persistUserSettings();
  updateWorkingDirectoryLabel();
  refreshWorkingDirectoryAvailability({ logChange: false });
});

function showConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) {
    modal.classList.add('show');
    playErrorJingle();
  }
}

function playErrorJingle() {
  if (!notoMixerConfig.errorJingle) return;
  const errorSound = new Audio(
    getNotoMixerAssetUrl('audio', 'error.mp3')
  );
  errorSound.play().catch(e => console.log('Could not play error sound:', e));
}

function hideConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}

let cachedAudioOutputs = null;
let audioDeviceRefreshPromise = null;
let audioDeviceRefreshScheduled = false;

function renderAudioDevices(audioOutputs) {
  const mainSelect = document.getElementById('setting-main-audio');
  const previewSelect = document.getElementById('setting-preview-audio');
  if (!mainSelect || !previewSelect) return;

  const savedMain = localStorage.getItem('notoMixer_mainAudioDevice') || 'default';
  const savedPreview = localStorage.getItem('notoMixer_previewAudioDevice') || 'default';
  const desiredMain = mainSelect.dataset.devicesReady === 'true' ? mainSelect.value : savedMain;
  const desiredPreview = previewSelect.dataset.devicesReady === 'true' ? previewSelect.value : savedPreview;

  const buildOptions = () => {
    const fragment = document.createDocumentFragment();
    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = 'Default';
    fragment.appendChild(defaultOption);

    audioOutputs.forEach(device => {
      const deviceIdStr = device.deviceId || '';
      const option = document.createElement('option');
      option.value = deviceIdStr;
      option.textContent = device.label || `Output Device (${deviceIdStr.slice(0, 5)}...)`;
      fragment.appendChild(option);
    });
    return fragment;
  };

  mainSelect.replaceChildren(buildOptions());
  previewSelect.replaceChildren(buildOptions());
  mainSelect.value = Array.from(mainSelect.options).some(option => option.value === desiredMain)
    ? desiredMain
    : 'default';
  previewSelect.value = Array.from(previewSelect.options).some(option => option.value === desiredPreview)
    ? desiredPreview
    : 'default';
  mainSelect.dataset.devicesReady = 'true';
  previewSelect.dataset.devicesReady = 'true';
}

async function populateAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    logConsole("Err Settings: Media devices enumeration not supported in this environment", "err");
    return;
  }

  if (audioDeviceRefreshPromise) return audioDeviceRefreshPromise;

  audioDeviceRefreshPromise = navigator.mediaDevices.enumerateDevices()
    .then(devices => {
      cachedAudioOutputs = devices.filter(device => device.kind === 'audiooutput');
      renderAudioDevices(cachedAudioOutputs);
      logConsole(`Settings: Found ${cachedAudioOutputs.length} audio output devices`, 'system');
    })
    .catch(err => {
      logConsole(`Err Settings: Failed to populate devices: ${err.message}`, 'err');
      console.error("Error populating audio devices:", err);
    })
    .finally(() => {
      audioDeviceRefreshPromise = null;
    });

  return audioDeviceRefreshPromise;
}

function scheduleAudioDeviceRefresh() {
  if (cachedAudioOutputs) renderAudioDevices(cachedAudioOutputs);
  if (audioDeviceRefreshScheduled || audioDeviceRefreshPromise) return;

  audioDeviceRefreshScheduled = true;
  requestAnimationFrame(() => {
    // Let the settings overlay paint before Electron queries the operating system.
    setTimeout(() => {
      audioDeviceRefreshScheduled = false;
      populateAudioDevices();
    }, 0);
  });
}

let zoomText = 100;
let zoomWaveform = 100;
let zoomButtons = 100;
let zoomCover = 100;

function applyZoomSettings() {
  document.documentElement.style.setProperty('--zoom-text', zoomText / 100);
  document.documentElement.style.setProperty('--zoom-waveform', zoomWaveform / 100);
  document.documentElement.style.setProperty('--zoom-buttons', zoomButtons / 100);
  document.documentElement.style.setProperty('--zoom-cover-scale', zoomCover / 100);
}

function loadZoomSettings() {
  const savedText = localStorage.getItem('notoMixer_zoomText');
  const savedWaveform = localStorage.getItem('notoMixer_zoomWaveform');
  const savedButtons = localStorage.getItem('notoMixer_zoomButtons');
  const savedCover = localStorage.getItem('notoMixer_zoomCover');

  zoomText = savedText !== null ? parseInt(savedText) : 100;
  zoomWaveform = savedWaveform !== null ? parseInt(savedWaveform) : 100;
  zoomButtons = savedButtons !== null ? parseInt(savedButtons) : 100;
  zoomCover = savedCover !== null ? parseInt(savedCover) : 100;

  applyZoomSettings();
}

function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.classList.add('show');
  }
  populateKeyboardBindingInputs();
  refreshMidiControllerUI();
  populateJogPhysicsSettingsUI();
  scheduleAudioDeviceRefresh();
  if (isCurrentUpdateDeferred()) {
    settingsUpdateAcknowledged = true;
    renderAppUpdateBadges();
  }

  const openingSilenceCheck = document.getElementById('setting-skip-opening-silence');
  const endingSilenceCheck = document.getElementById('setting-skip-ending-silence');
  const endingWarningCheck = document.getElementById('setting-music-ending-warning');
  if (openingSilenceCheck) openingSilenceCheck.checked = skipOpeningSilence;
  if (endingSilenceCheck) endingSilenceCheck.checked = skipEndingSilence;
  if (endingWarningCheck) endingWarningCheck.checked = musicEndingWarning;

  // Set zoom sliders and labels
  const zoomTextSlider = document.getElementById('setting-zoom-text');
  const zoomTextDisplay = document.getElementById('zoom-text-display');
  if (zoomTextSlider) {
    zoomTextSlider.value = zoomText;
    if (zoomTextDisplay) zoomTextDisplay.textContent = `${zoomText}%`;
  }
  
  const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
  const zoomWaveformDisplay = document.getElementById('zoom-waveform-display');
  if (zoomWaveformSlider) {
    zoomWaveformSlider.value = zoomWaveform;
    if (zoomWaveformDisplay) zoomWaveformDisplay.textContent = `${zoomWaveform}%`;
  }

  const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
  const zoomButtonsDisplay = document.getElementById('zoom-buttons-display');
  if (zoomButtonsSlider) {
    zoomButtonsSlider.value = zoomButtons;
    if (zoomButtonsDisplay) zoomButtonsDisplay.textContent = `${zoomButtons}%`;
  }

  const zoomCoverSlider = document.getElementById('setting-zoom-cover');
  const zoomCoverDisplay = document.getElementById('zoom-cover-display');
  if (zoomCoverSlider) {
    zoomCoverSlider.value = zoomCover;
    if (zoomCoverDisplay) zoomCoverDisplay.textContent = `${zoomCover}%`;
  }
}

function hideSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}

function loadSnapSettings() {
  const savedEnabled = localStorage.getItem('notoMixer_snapEnabled');
  const savedThreshold = localStorage.getItem('notoMixer_snapThreshold');
  
  if (savedEnabled !== null) {
    snapEnabled = (savedEnabled === 'true');
  } else {
    snapEnabled = false; // default off
  }
  
  if (savedThreshold !== null) {
    snapThresholdPct = parseInt(savedThreshold) || 5;
  } else {
    snapThresholdPct = 5;
  }
}

function loadMusicSettings() {
  skipOpeningSilence = localStorage.getItem('notoMixer_skipOpeningSilence') === 'true';
  skipEndingSilence = localStorage.getItem('notoMixer_skipEndingSilence') === 'true';
  musicEndingWarning = localStorage.getItem('notoMixer_musicEndingWarning') === 'true';
}

let layoutMode = 'default';

function loadLayoutSettings() {
  const savedLayout = localStorage.getItem('notoMixer_layoutMode');
  if (savedLayout !== null) {
    layoutMode = savedLayout;
  } else {
    layoutMode = 'default';
  }
  applyLayoutMode(layoutMode);

  localStorage.removeItem('notoMixer_explorerLayout');
  localStorage.removeItem('notoMixer_explorerWidth');
  applyExplorerLayout();
  persistUserSettings();
}

function applyLayoutMode(mode) {
  layoutMode = mode;
  const container = document.body;
  const block1 = document.getElementById('visualizer-block-1');
  const block2 = document.getElementById('visualizer-block-2');
  const stackedArea = document.getElementById('stacked-visualizer-area');
  const stackedHandle = document.getElementById('stacked-resize-handle');
  
  if (mode === 'stacked') {
    container.classList.add('layout-stacked');
    if (stackedArea && block1 && block2) {
      stackedArea.appendChild(block1);
      stackedArea.appendChild(block2);
      stackedArea.style.display = 'flex';
      
      const savedHeight = localStorage.getItem('notoMixer_stackedHeight');
      if (savedHeight) {
        stackedArea.style.height = savedHeight + 'px';
      }
      
      if (stackedHandle) stackedHandle.style.display = 'block';
    }
  } else {
    container.classList.remove('layout-stacked');
    if (stackedArea) {
      stackedArea.style.display = 'none';
    }
    if (stackedHandle) {
      stackedHandle.style.display = 'none';
    }
    const body1 = document.querySelector('#track-1 .track-body');
    if (body1 && block1) {
      body1.insertBefore(block1, body1.firstChild);
    }
    
    const body2 = document.querySelector('#track-2 .track-body');
    if (body2 && block2) {
      body2.insertBefore(block2, body2.firstChild);
    }
  }
  
  const layoutSelect = document.getElementById('setting-layout-mode');
  if (layoutSelect) {
    layoutSelect.value = mode;
  }
}

function applyExplorerLayout() {
  const workspace = document.querySelector('.exertia-workspace');
  const sidebar = document.querySelector('.exertia-sidebar');
  if (workspace && sidebar) {
    workspace.classList.add('explorer-bottom');
    const savedHeight = localStorage.getItem('notoMixer_explorerHeight') || '180';
    sidebar.style.height = savedHeight + 'px';
    sidebar.style.width = '100%';
  }
}

const MUSICAL_KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_KEY_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_KEY_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function transformFftInPlace(real, imaginary) {
  const size = real.length;

  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
    const halfSize = blockSize >> 1;
    const angle = (-2 * Math.PI) / blockSize;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);

    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < halfSize; offset++) {
        const evenIndex = blockStart + offset;
        const oddIndex = evenIndex + halfSize;
        const oddReal = (real[oddIndex] * twiddleReal)
          - (imaginary[oddIndex] * twiddleImaginary);
        const oddImaginary = (real[oddIndex] * twiddleImaginary)
          + (imaginary[oddIndex] * twiddleReal);

        real[oddIndex] = real[evenIndex] - oddReal;
        imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary;
        real[evenIndex] += oddReal;
        imaginary[evenIndex] += oddImaginary;

        const nextTwiddleReal = (twiddleReal * stepReal)
          - (twiddleImaginary * stepImaginary);
        twiddleImaginary = (twiddleReal * stepImaginary)
          + (twiddleImaginary * stepReal);
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

function scoreMusicalKeyProfile(chroma, profile, rootPitchClass) {
  const chromaMean = chroma.reduce((sum, value) => sum + value, 0) / 12;
  const profileMean = profile.reduce((sum, value) => sum + value, 0) / 12;
  let numerator = 0;
  let chromaVariance = 0;
  let profileVariance = 0;

  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    const chromaValue = chroma[pitchClass] - chromaMean;
    const profileValue = profile[(pitchClass - rootPitchClass + 12) % 12] - profileMean;
    numerator += chromaValue * profileValue;
    chromaVariance += chromaValue * chromaValue;
    profileVariance += profileValue * profileValue;
  }

  const denominator = Math.sqrt(chromaVariance * profileVariance);
  return denominator > 0 ? numerator / denominator : -Infinity;
}

function estimateMusicalKey(audioBuffer) {
  try {
    const fftSize = 4096;
    const sampleRate = audioBuffer.sampleRate;
    const sampleLength = audioBuffer.length;
    if (!sampleRate || sampleLength < fftSize) return '--';

    const channelCount = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1));
    const channels = Array.from(
      { length: channelCount },
      (_, channel) => audioBuffer.getChannelData(channel)
    );
    const duration = sampleLength / sampleRate;
    const analysisStart = duration > 30 ? Math.floor(sampleRate * 10) : 0;
    const analysisEnd = duration > 20
      ? sampleLength - Math.floor(sampleRate * 5)
      : sampleLength;
    const availableSamples = Math.max(0, analysisEnd - analysisStart);
    const windowCount = Math.min(64, Math.floor(availableSamples / fftSize));
    if (windowCount < 1) return '--';

    const window = new Float64Array(fftSize);
    for (let index = 0; index < fftSize; index++) {
      window[index] = 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1)));
    }

    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    const magnitudes = new Float64Array((fftSize >> 1) + 1);
    const chroma = new Float64Array(12);
    const firstBin = Math.max(1, Math.ceil((55 * fftSize) / sampleRate));
    const lastBin = Math.min(fftSize >> 1, Math.floor((3520 * fftSize) / sampleRate));
    const offsetRange = Math.max(0, availableSamples - fftSize);
    let validWindows = 0;

    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const ratio = windowCount === 1 ? 0 : windowIndex / (windowCount - 1);
      const start = analysisStart + Math.floor(offsetRange * ratio);
      let mean = 0;
      for (let index = 0; index < fftSize; index++) {
        let sample = 0;
        for (const channel of channels) sample += channel[start + index] || 0;
        sample /= channelCount;
        real[index] = sample;
        mean += sample;
      }
      mean /= fftSize;

      let energy = 0;
      for (let index = 0; index < fftSize; index++) {
        const centered = real[index] - mean;
        energy += centered * centered;
        real[index] = centered * window[index];
        imaginary[index] = 0;
      }
      if ((energy / fftSize) < 1e-7) continue;

      transformFftInPlace(real, imaginary);
      for (let bin = firstBin; bin <= lastBin; bin++) {
        magnitudes[bin] = Math.hypot(real[bin], imaginary[bin]);
      }

      const frameChroma = new Float64Array(12);
      for (let bin = firstBin + 1; bin < lastBin; bin++) {
        const magnitude = magnitudes[bin];
        if (magnitude <= magnitudes[bin - 1] || magnitude < magnitudes[bin + 1]) continue;

        const frequency = (bin * sampleRate) / fftSize;
        const midiNote = 69 + (12 * Math.log2(frequency / 440));
        const nearestNote = Math.round(midiNote);
        const distance = Math.abs(midiNote - nearestNote);
        const tuningWeight = Math.pow(Math.cos(Math.PI * distance), 2);
        const pitchClass = ((nearestNote % 12) + 12) % 12;
        const frequencyWeight = Math.max(0.35, Math.min(1, Math.sqrt(220 / frequency)));
        frameChroma[pitchClass] += Math.log1p(magnitude) * tuningWeight * frequencyWeight;
      }

      const frameTotal = frameChroma.reduce((sum, value) => sum + value, 0);
      if (frameTotal <= 0) continue;
      for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
        chroma[pitchClass] += frameChroma[pitchClass] / frameTotal;
      }
      validWindows += 1;
    }

    if (validWindows === 0) return '--';
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      chroma[pitchClass] /= validWindows;
    }

    let best = { score: -Infinity, root: 0, minor: false };
    for (let root = 0; root < 12; root++) {
      const majorScore = scoreMusicalKeyProfile(chroma, MAJOR_KEY_PROFILE, root);
      if (majorScore > best.score) best = { score: majorScore, root, minor: false };
      const minorScore = scoreMusicalKeyProfile(chroma, MINOR_KEY_PROFILE, root);
      if (minorScore > best.score) best = { score: minorScore, root, minor: true };
    }

    return `${MUSICAL_KEY_NAMES[best.root]}${best.minor ? 'm' : ''}`;
  } catch (error) {
    console.error('Error during musical key estimation:', error);
    return '--';
  }
}

function estimateBPM(audioBuffer) {
  try {
    const rawData = audioBuffer.getChannelData(0); // Use first channel
    const sampleRate = audioBuffer.sampleRate;
    
    // Select a representative 45-second chunk from a part of the song where the main beat is active
    // Starting at 60 seconds to bypass drumless intros/buildups (like in "I Gotta Feeling")
    let startSec = 0;
    if (audioBuffer.duration > 90) {
      startSec = 60; // Start at 60 seconds for normal length tracks
    } else if (audioBuffer.duration > 30) {
      startSec = 15; // Start at 15 seconds for short tracks
    }
    const startOffset = Math.floor(sampleRate * startSec);
    const analysisDuration = 45; // seconds
    const sampleLength = Math.min(Math.floor(sampleRate * analysisDuration), rawData.length - startOffset);
    
    if (sampleLength <= 0) return 120;
    
    // Apply a software Low Pass Filter at ~150Hz to isolate bass transients (kicks)
    // First-order IIR LPF: y[n] = alpha * x[n] + (1 - alpha) * y[n-1]
    const fc = 150;
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * fc);
    const alpha = dt / (rc + dt);
    
    const filteredData = new Float32Array(sampleLength);
    let lastOut = 0;
    for (let i = 0; i < sampleLength; i++) {
      const x = rawData[startOffset + i];
      filteredData[i] = alpha * x + (1 - alpha) * lastOut;
      lastOut = filteredData[i];
    }
    
    // Downsample the filtered data to a sampling rate of ~1000Hz (1ms resolution)
    const dsFactor = Math.max(1, Math.round(sampleRate / 1000));
    const dsLength = Math.floor(sampleLength / dsFactor);
    const envelope = new Float32Array(dsLength);
    
    for (let i = 0; i < dsLength; i++) {
      let maxVal = 0;
      const start = i * dsFactor;
      const end = Math.min(start + dsFactor, sampleLength);
      for (let j = start; j < end; j++) {
        const val = Math.abs(filteredData[j]);
        if (val > maxVal) maxVal = val;
      }
      envelope[i] = maxVal;
    }
    
    // Compute the temporal onset envelope (first-order derivative of energy)
    const onset = new Float32Array(dsLength);
    for (let i = 1; i < dsLength; i++) {
      onset[i] = Math.max(0, envelope[i] - envelope[i - 1]);
    }
    
    // Autocorrelation match scoring over standard tempos (75 to 160 BPM)
    let bestBpm = 120;
    let maxScore = 0;
    
    for (let bpm = 75; bpm <= 160; bpm++) {
      const beatIntervalMs = 60000 / bpm;
      let score = 0;
      
      // Calculate autocorrelation at the fundamental beat interval and its first 3 sub-harmonics
      const lags = [beatIntervalMs, beatIntervalMs * 2, beatIntervalMs * 3, beatIntervalMs * 4];
      const weights = [1.0, 0.75, 0.45, 0.2];
      
      for (let j = 0; j < lags.length; j++) {
        const lag = Math.round(lags[j]);
        if (lag < dsLength) {
          let sum = 0;
          let count = 0;
          // Step by 4 for fast computation while preserving full alignment representation
          for (let i = 0; i < dsLength - lag; i += 4) {
            sum += onset[i] * onset[i + lag];
            count++;
          }
          if (count > 0) {
            score += weights[j] * (sum / count);
          }
        }
      }
      
      if (score > maxScore) {
        maxScore = score;
        bestBpm = bpm;
      }
    }
    
    return bestBpm;
  } catch (err) {
    console.error("Error during BPM estimation:", err);
    return 120;
  }
}

function estimateBeatOffset(audioBuffer, bpm) {
  try {
    const rawData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    
    // Scan the first 15 seconds to find the first beat offset
    const scanDuration = 15;
    const sampleLength = Math.min(Math.floor(sampleRate * scanDuration), rawData.length);
    
    if (sampleLength <= 0) return 0;
    
    // Low pass filter at 150Hz
    const fc = 150;
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * fc);
    const alpha = dt / (rc + dt);
    
    const filteredData = new Float32Array(sampleLength);
    let lastOut = 0;
    for (let i = 0; i < sampleLength; i++) {
      filteredData[i] = alpha * rawData[i] + (1 - alpha) * lastOut;
      lastOut = filteredData[i];
    }
    
    // Downsample to 1000Hz (1ms resolution)
    const dsFactor = Math.max(1, Math.round(sampleRate / 1000));
    const dsLength = Math.floor(sampleLength / dsFactor);
    const envelope = new Float32Array(dsLength);
    
    for (let i = 0; i < dsLength; i++) {
      let maxVal = 0;
      const start = i * dsFactor;
      const end = Math.min(start + dsFactor, sampleLength);
      for (let j = start; j < end; j++) {
        const val = Math.abs(filteredData[j]);
        if (val > maxVal) maxVal = val;
      }
      envelope[i] = maxVal;
    }
    
    // Compute derivative (onset function)
    const onset = new Float32Array(dsLength);
    for (let i = 1; i < dsLength; i++) {
      onset[i] = Math.max(0, envelope[i] - envelope[i - 1]);
    }
    
    // Find peaks in the onset curve
    let sum = 0;
    for (let i = 0; i < dsLength; i++) sum += onset[i];
    const avgOnset = sum / dsLength;
    const threshold = avgOnset * 2.0; // Higher threshold for clear transients
    
    const beatDurationMs = 60000 / bpm;
    const minPeakDist = Math.round(beatDurationMs * 0.85); // 15% tolerance
    
    const peaksMs = [];
    let lastPeakIdx = -minPeakDist;
    for (let i = 1; i < dsLength - 1; i++) {
      if (onset[i] > onset[i - 1] && onset[i] > onset[i + 1] && onset[i] > threshold) {
        if (i - lastPeakIdx >= minPeakDist) {
          peaksMs.push(i); // peak index represents milliseconds
          lastPeakIdx = i;
        }
      }
    }
    
    if (peaksMs.length === 0) return 0;
    
    // Score candidate offsets
    const beatDurationSec = 60 / bpm;
    let bestOffsetSec = 0;
    let maxScore = 0;
    
    // Test the first 5 peaks as candidate offsets
    const candidates = peaksMs.slice(0, 5).map(p => (p / 1000) % beatDurationSec);
    
    candidates.forEach(cand => {
      let score = 0;
      peaksMs.forEach(p => {
        const pSec = p / 1000;
        const diff = Math.abs((pSec - cand) % beatDurationSec);
        const minDiff = Math.min(diff, beatDurationSec - diff);
        if (minDiff < 0.04) { // 40ms alignment tolerance
          score += (1 - minDiff / 0.04);
        }
      });
      
      if (score > maxScore) {
        maxScore = score;
        bestOffsetSec = cand;
      }
    });
    
    return bestOffsetSec;
  } catch (err) {
    console.error("Failed to estimate beat offset:", err);
    return 0;
  }
}

function buildSongAnalysisWorkerSource() {
  return `
    const MUSICAL_KEY_NAMES = ${JSON.stringify(MUSICAL_KEY_NAMES)};
    const MAJOR_KEY_PROFILE = ${JSON.stringify(MAJOR_KEY_PROFILE)};
    const MINOR_KEY_PROFILE = ${JSON.stringify(MINOR_KEY_PROFILE)};
    ${transformFftInPlace.toString()}
    ${scoreMusicalKeyProfile.toString()}
    ${estimateMusicalKey.toString()}
    ${estimateBPM.toString()}
    ${estimateBeatOffset.toString()}
    ${generateCombinedWaveformPeaks.toString()}
    ${downsampleWaveformPeaks.toString()}
    ${detectSilenceBoundaries.toString()}

    function restoreAudioBuffer(serializedBuffer) {
      return {
        sampleRate: serializedBuffer.sampleRate,
        length: serializedBuffer.length,
        duration: serializedBuffer.length / serializedBuffer.sampleRate,
        numberOfChannels: serializedBuffer.channels.length,
        getChannelData(channel) {
          return serializedBuffer.channels[channel];
        }
      };
    }

    self.onmessage = event => {
      const message = event.data;
      try {
        const audioBuffers = message.buffers.map(restoreAudioBuffer);
        const mainBuffer = audioBuffers[0];
        const duration = Math.max(...audioBuffers.map(buffer => buffer.duration));
        const bpm = estimateBPM(mainBuffer);
        const key = estimateMusicalKey(mainBuffer);
        const offset = estimateBeatOffset(mainBuffer, bpm);
        const waveformPeaks = generateCombinedWaveformPeaks(audioBuffers, 2000);
        const peaks = downsampleWaveformPeaks(waveformPeaks, 60);
        const silence = detectSilenceBoundaries(audioBuffers);
        self.postMessage({
          id: message.id,
          result: { duration, bpm, key, offset, waveformPeaks, peaks, silence }
        });
      } catch (error) {
        self.postMessage({
          id: message.id,
          error: {
            message: error && error.message ? error.message : String(error),
            stack: error && error.stack ? error.stack : ''
          }
        });
      }
    };
  `;
}

class SongAnalysisWorkerPool {
  constructor(size) {
    this.size = size;
    this.nextJobId = 1;
    this.pending = [];
    this.workers = [];
    this.destroyed = false;
    this.pumpScheduled = false;
    this.workerSource = buildSongAnalysisWorkerSource();
    this.workerUrl = URL.createObjectURL(new Blob(
      [this.workerSource],
      { type: 'text/javascript' }
    ));
    for (let index = 0; index < size; index++) this.spawnWorker();
  }

  spawnWorker() {
    if (this.destroyed) return;
    const state = {
      worker: new window.Worker(this.workerUrl),
      busy: false,
      currentJob: null,
      failed: false
    };
    this.workers.push(state);

    state.worker.onmessage = event => {
      const message = event.data;
      const job = state.currentJob;
      if (!job || message.id !== job.id) return;
      state.currentJob = null;
      state.busy = false;
      if (message.error) {
        const error = new Error(message.error.message);
        if (message.error.stack) error.stack = message.error.stack;
        job.reject(error);
      } else {
        job.resolve(message.result);
      }
      this.schedulePump();
    };

    state.worker.onerror = event => {
      event.preventDefault();
      this.failWorker(
        state,
        new Error(event.message || 'Song analysis worker failed.')
      );
    };
    this.schedulePump();
  }

  failWorker(state, error) {
    if (state.failed) return;
    state.failed = true;
    const workerIndex = this.workers.indexOf(state);
    if (workerIndex >= 0) this.workers.splice(workerIndex, 1);
    if (state.currentJob) state.currentJob.reject(error);
    state.currentJob = null;
    state.busy = false;
    state.worker.terminate();
    if (!this.destroyed) this.spawnWorker();
  }

  analyze(audioBuffers) {
    return new Promise((resolve, reject) => {
      this.pending.push({
        id: this.nextJobId++,
        audioBuffers,
        resolve,
        reject
      });
      this.schedulePump();
    });
  }

  async serializeAudioBuffers(audioBuffers) {
    const transferList = [];
    const buffers = [];
    for (const audioBuffer of audioBuffers) {
      const channels = [];
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        channels.push(channelData);
        transferList.push(channelData.buffer);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      buffers.push({
        sampleRate: audioBuffer.sampleRate,
        length: audioBuffer.length,
        channels
      });
    }
    return { buffers, transferList };
  }

  schedulePump() {
    if (this.destroyed || this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.pump();
    }, 0);
  }

  pump() {
    if (this.destroyed) return;
    const state = this.workers.find(workerState => !workerState.busy);
    if (!state || this.pending.length === 0) return;
    const job = this.pending.shift();
    state.busy = true;
    state.currentJob = job;
    this.serializeAudioBuffers(job.audioBuffers)
      .then(({ buffers, transferList }) => {
        if (this.destroyed || state.currentJob !== job) return;
        job.audioBuffers = null;
        state.worker.postMessage({ id: job.id, buffers }, transferList);
      })
      .catch(error => {
        state.currentJob = null;
        state.busy = false;
        job.reject(error);
      })
      .finally(() => this.schedulePump());
  }

  terminate() {
    this.destroyed = true;
    const error = new Error('Song analysis worker pool was terminated.');
    for (const job of this.pending.splice(0)) job.reject(error);
    for (const state of this.workers.splice(0)) {
      if (state.currentJob) state.currentJob.reject(error);
      state.worker.terminate();
    }
    URL.revokeObjectURL(this.workerUrl);
  }
}

function getSongAnalysisWorkerPool() {
  if (!songAnalysisWorkerPool) {
    songAnalysisWorkerPool = new SongAnalysisWorkerPool(SONG_ANALYZER_WORKER_COUNT);
    logConsole(
      `NotoMixer Song Analyzer Daemon: ${SONG_ANALYZER_WORKER_COUNT} CPU workers ` +
      `(${songAnalyzerLogicalCoreCount} logical cores detected)`,
      'system'
    );
  }
  return songAnalysisWorkerPool;
}

window.addEventListener('beforeunload', () => {
  if (songAnalysisWorkerPool) songAnalysisWorkerPool.terminate();
});

function applyCenterSnap(param, newVal) {
  if (!snapEnabled) return newVal;
  
  let target = null;
  let range = null;
  
  const p = param.toUpperCase();
  if (['BASS', 'LOW', 'TREB', 'PITCH', 'PAN'].includes(p)) {
    target = 0;
    range = (p === 'PAN') ? 200 : 24; // Pan range is 200 (-100 to 100), others are 24 (-12 to 12)
  } else if (p === 'FILT' || p === 'FILTER') {
    target = 50;
    range = 100;
  } else if (p === 'SPEED') {
    target = 100;
    range = 150; // min 50, max 200
  }
  
  if (target !== null && range !== null) {
    const thresholdVal = (snapThresholdPct / 100) * range;
    if (Math.abs(newVal - target) <= thresholdVal) {
      return target;
    }
  }
  
  return newVal;
}

async function handleDeviceLost() {
  logConsole('Warning: Device has been lost (unplugged).', 'err');
  
  if (serialReaderLoop) {
    try { await serialReaderLoop.cancel(); } catch(e){}
    serialReaderLoop = null;
  }
  
  if (activeWriter) {
    try { activeWriter.releaseLock(); } catch(e){}
    activeWriter = null;
  }
  
  if (activePort) {
    try { await activePort.close(); } catch(e){}
    activePort = null;
  }
  
  setConnectedStatus(false);
  showConnectionModal();
}

let autoConnectInterval = null;

function startAutoConnectScanner() {
  if (autoConnectInterval) return;
  autoConnectInterval = setInterval(async () => {
    if (activePort) return; // Already connected
    if (navigator.serial) {
      try {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          const port = ports[0];
          logConsole('Info: Auto-scanner detected COM port. Connecting...', 'system');
          await port.open({ baudRate: 115200 });
          
          activePort = port;
          activeWriter = port.writable.getWriter();
          
          // Update UI dropdown
          const select = document.getElementById('port-select');
          let portName = 'COM';
          if (select && select.options.length > 1) {
            select.selectedIndex = 1;
            portName = select.value;
            select.disabled = true;
          }
          
          setConnectedStatus(true, portName);
          startReading(port);
          await initSerialHandshake();
          
          logConsole(`Success: Connected to ${portName}!`, 'system');
          hideConnectionModal();
          maybeShowEvaluationNotice();
        }
      } catch (err) {
        // Silently skip if port cannot be opened (e.g., unplugged or locked)
      }
    }
  }, 1000);
}

async function scanPorts() {
  logConsole('Info: Scanning and automatically connecting serial ports...', 'system');
  ipcRenderer.send('set-target-port', '');
  
  try {
    const port = await navigator.serial.requestPort();
    if (port) {
      await port.open({ baudRate: 115200 });
      
      activePort = port;
      activeWriter = port.writable.getWriter();
      
      // Update UI dropdown
      const select = document.getElementById('port-select');
      let portName = 'COM';
      if (select && select.options.length > 1) {
        select.selectedIndex = 1;
        portName = select.value;
        select.disabled = true;
      }
      
      setConnectedStatus(true, portName);
      startReading(port);
      await initSerialHandshake();
      
      logConsole(`Success: Automatically connected to ${portName}!`, 'system');
    }
  } catch (err) {
    logConsole(`Info: No serial port found or connection failed: ${err.message}`, 'system');
  }
}

ipcRenderer.on('serial-ports-list', (event, portList) => {
  const select = document.getElementById('port-select');
  const prevVal = select.value;
  select.innerHTML = '<option value="">None</option>';
  
  portList.forEach(port => {
    const opt = document.createElement('option');
    opt.value = port.portName;
    opt.textContent = port.portName;
    select.appendChild(opt);
  });

  if (prevVal && portList.find(p => p.portName === prevVal)) {
    select.value = prevVal;
  }
  
  logConsole(`Info: COM ports detected: [${portList.map(p => p.portName).join(', ')}]`, 'system');
});

async function toggleConnection() {
  const select = document.getElementById('port-select');
  const portName = select.value;

  if (activePort) {
    logConsole('Info: Serial disconnect...', 'system');
    try {
      await sendSerialMessage('CONN:0');
      
      if (serialReaderLoop) {
        await serialReaderLoop.cancel();
        serialReaderLoop = null;
      }
      
      if (activeWriter) {
        activeWriter.releaseLock();
        activeWriter = null;
      }
      
      await activePort.close();
      activePort = null;
      
      setConnectedStatus(false);
      logConsole('Success: Disconnected from ESP32.', 'system');
    } catch (err) {
      logConsole(`Err: Disconnect failed: ${err.message}`, 'err');
      activePort = null;
      activeWriter = null;
      setConnectedStatus(false);
    }
  } else {
    if (!portName) {
      logConsole('Warning: Select a COM port!', 'err');
      return;
    }
    
    logConsole(`Info: Connecting to ${portName}...`, 'system');
    ipcRenderer.send('set-target-port', portName);
    
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      
      activePort = port;
      activeWriter = port.writable.getWriter();
      
      setConnectedStatus(true, portName);
      startReading(port);
      await initSerialHandshake();
      
      logConsole(`Success: Connected to ${portName}!`, 'system');
      hideConnectionModal();
      maybeShowEvaluationNotice();
    } catch (err) {
      logConsole(`Err: Serial connection failed: ${err.message}`, 'err');
    }
  }
}

function setConnectedStatus(connected, portName = '') {
  const led = document.getElementById('connection-led');
  const text = document.getElementById('connection-status');
  const btn = document.getElementById('btn-connect');
  const select = document.getElementById('port-select');
  
  if (connected) {
    led.className = 'conn-led connected';
    text.textContent = `CONNECTED: ${portName}`;
    btn.textContent = 'DISCONNECT';
    select.disabled = true;
  } else {
    led.className = 'conn-led disconnected';
    text.textContent = 'DISCONNECTED';
    btn.textContent = 'CONNECT';
    select.disabled = false;
  }
}

function animateValue(trackNum, paramKey, startVal, targetVal, setterFn) {
  if (notoMixerConfig.legacyMode) {
    setterFn(trackNum, targetVal, false);
    return;
  }
  const duration = 800; // 800ms duration for a smooth visual sweep
  const startTime = performance.now();
  
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    
    // Easing function (easeOutQuad)
    const easeProgress = progress * (2 - progress);
    let currentVal = startVal + (targetVal - startVal) * easeProgress;
    
    if (!paramKey.endsWith('_SPEED') && !paramKey.endsWith('_POS')) {
      currentVal = Math.round(currentVal);
    }
    
    if (progress < 1) {
      if (paramKey.endsWith('_POS')) {
        setterFn(trackNum, currentVal, true); // forceNoAudioSeek = true
      } else {
        setterFn(trackNum, currentVal);
      }
      requestAnimationFrame(update);
    } else {
      setterFn(trackNum, targetVal, false);
    }
  }
  
  requestAnimationFrame(update);
}

async function initSerialHandshake() {
  syncedParams = {}; // Reset tracking so we re-animate knobs on handshake completion
  if (handshakeInterval) {
    clearInterval(handshakeInterval);
  }

  // Send CONN:1 immediately
  await sendSerialMessage('CONN:1');

  let attempts = 1;
  handshakeInterval = setInterval(async () => {
    if (activePort && attempts < 5) {
      await sendSerialMessage('CONN:1');
      attempts++;
    } else {
      clearInterval(handshakeInterval);
      handshakeInterval = null;
    }
  }, 1000);
}

// -------------------------------------------------------------
// Serial Read/Write Processing (TX/RX)
// -------------------------------------------------------------

async function sendSerialMessage(msg) {
  if (activeWriter) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(msg + '\n');
      await activeWriter.write(data);
      logConsole(`TX (Serial) -> ${msg}`, 'tx');
    } catch (err) {
      logConsole(`Err: Serial write failed: ${err.message}`, 'err');
    }
  }
  
  if (esp32Ip) {
    try {
      const dgram = require('dgram');
      const client = dgram.createSocket('udp4');
      const data = Buffer.from(msg + '\n');
      client.send(data, esp32Port, esp32Ip, (err) => {
        client.close();
        if (err) {
          logConsole(`Err UDP TX: ${err.message}`, 'err');
        } else {
          logConsole(`TX (UDP) -> ${msg}`, 'tx');
        }
      });
    } catch (err) {
      logConsole(`Err UDP Invio: ${err.message}`, 'err');
    }
  }
}

async function startReading(port) {
  const textDecoder = new TextDecoderStream();
  serialReaderLoop = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();
  
  let buffer = '';
  
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buffer += value;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            parseIncomingMessage(line);
          }
        }
      }
    }
  } catch (err) {
    logConsole(`Err: Serial read error: ${err.message}`, 'err');
    if (activePort) {
      handleDeviceLost();
    }
  } finally {
    reader.releaseLock();
  }
}

function parseIncomingMessage(msg) {
  logConsole(`RX <- ${msg}`, 'rx');
  
  if (handshakeInterval) {
    clearInterval(handshakeInterval);
    handshakeInterval = null;
    logConsole("Info: ESP32 synchronization completed successfully!", "system");
  }
  
  const parts = msg.split(':');
  if (parts.length < 3) return;
  
  const trackStr = parts[0];
  const param = parts[1].toUpperCase();
  const val = parseInt(parts[2]);
  
  if (isNaN(val)) return;

  const trackNum = (trackStr === 'T1') ? 1 : (trackStr === 'T2') ? 2 : null;
  if (!trackNum) return;

  const paramKey = `${trackNum}_${param}`;
  const isFirstSync = !syncedParams[paramKey];
  if (isFirstSync) {
    syncedParams[paramKey] = true;
  }

  switch (param) {
    case 'VOL': {
      const mappedVol = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`vol-${trackNum}`).value) || 80;
        animateValue(trackNum, paramKey, start, mappedVol, setVolume);
      } else {
        setVolume(trackNum, mappedVol);
      }
      break;
    }
    case 'BASS': {
      const mappedGain = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`bass-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedGain, (t, v) => setEQ(t, 'bass', v));
      } else {
        setEQ(trackNum, 'bass', mappedGain);
      }
      break;
    }
    case 'LOW': {
      const mappedGain = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`low-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedGain, (t, v) => setEQ(t, 'low', v));
      } else {
        setEQ(trackNum, 'low', mappedGain);
      }
      break;
    }
    case 'TREB': {
      const mappedGain = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`treb-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedGain, (t, v) => setEQ(t, 'treb', v));
      } else {
        setEQ(trackNum, 'treb', mappedGain);
      }
      break;
    }
    case 'PITCH': {
      const mappedPitch = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`pitch-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedPitch, setPitch);
      } else {
        setPitch(trackNum, mappedPitch);
      }
      break;
    }
    case 'SPEED': {
      const mappedSpeed = (val / 1023) * 150 + 50; // 50% to 200%
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`speed-${trackNum}`).value) || 100;
        animateValue(trackNum, paramKey, start, mappedSpeed, setSpeed);
      } else {
        setSpeed(trackNum, mappedSpeed);
      }
      break;
    }
    case 'ECHO': {
      const mappedEcho = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`echo-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedEcho, setEcho);
      } else {
        setEcho(trackNum, mappedEcho);
      }
      break;
    }
    case 'FILT': {
      const mappedFilt = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`filter-${trackNum}`).value) || 50;
        animateValue(trackNum, paramKey, start, mappedFilt, setFilter);
      } else {
        setFilter(trackNum, mappedFilt);
      }
      break;
    }
    case 'PAN': {
      const mappedPan = Math.round((val / 1023) * 200 - 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`pan-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedPan, setPan);
      } else {
        setPan(trackNum, mappedPan);
      }
      break;
    }
    case 'REV': {
      const mappedRev = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`reverb-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedRev, setReverb);
      } else {
        setReverb(trackNum, mappedRev);
      }
      break;
    }
    case 'ECHOTIME': {
      const mappedEchoTime = Math.round((val / 1023) * 900 + 100); // 100 to 1000
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`echotime-${trackNum}`).value) || 350;
        animateValue(trackNum, paramKey, start, mappedEchoTime, setEchoTime);
      } else {
        setEchoTime(trackNum, mappedEchoTime);
      }
      break;
    }
    case 'INST': {
      const mappedVol = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`inst-${trackNum}`).value) || 100;
        animateValue(trackNum, paramKey, start, mappedVol, (t, v) => setStemVolume(t, 'inst', Math.round(v)));
      } else {
        setStemVolume(trackNum, 'inst', mappedVol);
      }
      break;
    }
    case 'MAIN': {
      const mappedVol = Math.round((val / 1023) * 100);
      setStemVolume(trackNum, 'main', mappedVol);
      break;
    }
    case 'LYR':
    case 'VOC': {
      const mappedVol = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`voc-${trackNum}`).value) || 100;
        animateValue(trackNum, paramKey, start, mappedVol, (t, v) => setStemVolume(t, 'vocals', Math.round(v)));
      } else {
        setStemVolume(trackNum, 'vocals', mappedVol);
      }
      break;
    }
    case 'POS': {
      const mappedPercent = Math.max(0, Math.min(100, Math.round((val / 2040) * 100)));
      if (isFirstSync) {
        const fill = document.getElementById(`progress-fill-${trackNum}`);
        const start = fill ? (parseFloat(fill.style.width) || 0) : 0;
        animateValue(trackNum, paramKey, start, mappedPercent, seekTrack);
      } else {
        seekTrack(trackNum, mappedPercent);
      }
      break;
    }
    case 'PLAY': {
      if (val === 1) togglePlayTrack(trackNum);
      break;
    }
    case 'STOP': {
      if (val === 1) stopTrack(trackNum);
      break;
    }
    default:
      logConsole(`Warning: Command '${param}' not handled`, 'err');
  }
}

function logConsole(text, type = '') {
  const consoleLog = document.getElementById('console-log');
  if (!consoleLog) return;
  
  const div = document.createElement('div');
  div.className = `log-line ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  consoleLog.appendChild(div);
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function sendManualCommand() {
  const input = document.getElementById('console-input');
  const cmd = input.value.trim();
  if (cmd) {
    if (activeWriter) {
      sendSerialMessage(cmd);
    } else {
      logConsole(`Simulator: Executing '${cmd}'`, 'system');
      parseIncomingMessage(cmd);
    }
    input.value = '';
  }
}

// -------------------------------------------------------------
// Real-time Canvas Rendering (exertia Solid Green Style)
// -------------------------------------------------------------

function startVisualizers() {
  [1, 2].forEach(trackNum => {
    const canvas = document.getElementById(`canvas-${trackNum}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    function resizeCanvas() {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    const track = tracks[trackNum];
    
    function draw() {
      requestAnimationFrame(draw);
      
      try {
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }
        
        const width = canvas.width;
        const height = canvas.height;
        if (width <= 0 || height <= 0) return;

        const trackColor = (trackNum === 1) ? '#00ffcc' : '#ff5500';

        // Hide or show the overview canvas
        const overviewCanvas = document.getElementById(`overview-canvas-${trackNum}`);
        if (overviewCanvas) {
          overviewCanvas.style.display = (track.visMode === 'waveform') ? 'block' : 'none';
        }
        
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        else if (track.isSynth && track.fallbackAudio) refAudio = track.fallbackAudio;

        updateTrackPlatterPosition(
          trackNum,
          refAudio && Number.isFinite(refAudio.currentTime) ? refAudio.currentTime : 0
        );
        
        const duration = (refAudio && refAudio.duration && !isNaN(refAudio.duration) && refAudio.duration > 0) ? refAudio.duration : 180;

        // Draw Overview Waveform if available and in waveform mode
        if (overviewCanvas && track.visMode === 'waveform' && track.staticWaveform && track.staticWaveform.length > 0) {
          const oCtx = overviewCanvas.getContext('2d');
          const oW = overviewCanvas.width = overviewCanvas.clientWidth;
          const oH = overviewCanvas.height = overviewCanvas.clientHeight;
          
          if (oW > 0 && oH > 0) {
            oCtx.fillStyle = '#0d0d0d';
            oCtx.fillRect(0, 0, oW, oH);
            
            // Draw continuous Audacity-style waveform for overview (unplayed grey base with gradient)
            const unplayedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
            unplayedGrad.addColorStop(0, '#2a2a2a');
            unplayedGrad.addColorStop(0.5, '#5c5c5c');
            unplayedGrad.addColorStop(1, '#2a2a2a');
            oCtx.fillStyle = unplayedGrad;
            
            oCtx.beginPath();
            let first = true;
            const step = oW / track.staticWaveform.length;
            for (let i = 0; i < track.staticWaveform.length; i++) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH - h) / 2;
              const x = i * step;
              if (first) {
                oCtx.moveTo(x, y);
                first = false;
              } else {
                oCtx.lineTo(x, y);
              }
            }
            for (let i = track.staticWaveform.length - 1; i >= 0; i--) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH + h) / 2;
              const x = i * step;
              oCtx.lineTo(x, y);
            }
            oCtx.closePath();
            oCtx.fill();
            
            // Fill the played portion in gradient color
            let currentPct = 0;
            if (refAudio) {
              currentPct = refAudio.currentTime / duration;
            }
            const playedX = Math.max(0, Math.min(oW, currentPct * oW));
            
            oCtx.save();
            oCtx.beginPath();
            oCtx.rect(0, 0, playedX, oH);
            oCtx.clip();
            
            const playedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
            if (track._waveformResetGraySettled) {
              playedGrad.addColorStop(0, '#2a2a2a');
              playedGrad.addColorStop(0.5, '#5c5c5c');
              playedGrad.addColorStop(1, '#2a2a2a');
            } else if (trackNum === 1) {
              playedGrad.addColorStop(0, '#00b38f');
              playedGrad.addColorStop(0.5, '#b3fff0');
              playedGrad.addColorStop(1, '#00b38f');
            } else {
              playedGrad.addColorStop(0, '#cc4400');
              playedGrad.addColorStop(0.5, '#ffccb3');
              playedGrad.addColorStop(1, '#cc4400');
            }
            oCtx.fillStyle = playedGrad;
            
            oCtx.beginPath();
            first = true;
            for (let i = 0; i < track.staticWaveform.length; i++) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH - h) / 2;
              const x = i * step;
              if (first) {
                oCtx.moveTo(x, y);
                first = false;
              } else {
                oCtx.lineTo(x, y);
              }
            }
            for (let i = track.staticWaveform.length - 1; i >= 0; i--) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH + h) / 2;
              const x = i * step;
              oCtx.lineTo(x, y);
            }
            oCtx.closePath();
            oCtx.fill();
            oCtx.restore();
            
            // Draw moving vertical playhead indicator (red line)
            oCtx.strokeStyle = '#ff003c';
            oCtx.lineWidth = 1.5;
            oCtx.beginPath();
            oCtx.moveTo(playedX, 0);
            oCtx.lineTo(playedX, oH);
            oCtx.stroke();

            // Highlight loop region on overview
            if (hasValidTrackLoopRange(track)) {
              const loopStartX = (track.loopStartTime / duration) * oW;
              const loopEndX = (track.loopEndTime / duration) * oW;
              
              oCtx.fillStyle = track.loopEnabled
                ? 'rgba(0, 255, 204, 0.25)'
                : 'rgba(145, 145, 145, 0.18)';
              oCtx.fillRect(loopStartX, 0, loopEndX - loopStartX, oH);
              oCtx.strokeStyle = track.loopEnabled ? '#00ffcc' : '#777777';
              oCtx.lineWidth = 1;
              oCtx.beginPath();
              oCtx.moveTo(loopStartX, 0); oCtx.lineTo(loopStartX, oH);
              oCtx.moveTo(loopEndX, 0); oCtx.lineTo(loopEndX, oH);
              oCtx.stroke();
            }
            
            // Highlight Play Whilst Holding active region on overview
            if (track.activeHoldCueIdx !== null && track.hotCues && track.hotCues[track.activeHoldCueIdx] !== null) {
              const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
              const activeColor = hotCueColors[track.activeHoldCueIdx % hotCueColors.length];
              const cueTime = track.hotCues[track.activeHoldCueIdx];
              
              const startX = (Math.min(cueTime, refAudio.currentTime) / duration) * oW;
              const endX = (Math.max(cueTime, refAudio.currentTime) / duration) * oW;
              
              let r = parseInt(activeColor.slice(1, 3), 16);
              let g = parseInt(activeColor.slice(3, 5), 16);
              let b = parseInt(activeColor.slice(5, 7), 16);
              
              oCtx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.25)`;
              oCtx.fillRect(startX, 0, endX - startX, oH);
              
              oCtx.strokeStyle = activeColor;
              oCtx.lineWidth = 1;
              oCtx.beginPath();
              oCtx.moveTo(startX, 0); oCtx.lineTo(startX, oH);
              oCtx.moveTo(endX, 0); oCtx.lineTo(endX, oH);
              oCtx.stroke();
            }

            // Draw Hot Cues on overview
            if (track.hotCues) {
              const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
              for (let i = 0; i < 8; i++) {
                const cueTime = track.hotCues[i];
                if (cueTime !== null) {
                  const cueColor = hotCueColors[i % hotCueColors.length];
                  const cueX = (cueTime / duration) * oW;
                  oCtx.fillStyle = cueColor;
                  oCtx.beginPath();
                  oCtx.moveTo(cueX - 3, 0);
                  oCtx.lineTo(cueX + 3, 0);
                  oCtx.lineTo(cueX, 4);
                  oCtx.fill();
                  oCtx.strokeStyle = cueColor;
                  oCtx.lineWidth = 1;
                  oCtx.beginPath();
                  oCtx.moveTo(cueX, 0);
                  oCtx.lineTo(cueX, oH);
                  oCtx.stroke();
                }
              }
            }
          }
        }
        
        // Loop Check
        if (track.loopEnabled && track.loopStartTime !== null && track.loopEndTime !== null && track.loopEndTime > track.loopStartTime) {
          if (refAudio) {
            if (track.loopRepeatEnabled) {
              const loopPosition = resolveTrackTimeWithinActiveLoop(
                trackNum,
                refAudio.currentTime,
                refAudio.duration
              );
              if (loopPosition.wrapped) {
                setTrackMediaTime(trackNum, loopPosition.time);
              }
            } else if (refAudio.currentTime >= track.loopEndTime) {
              if (track.isPlaying) {
                completeTrackOneShotLoop(trackNum);
              } else {
                setTrackMediaTime(trackNum, track.loopStartTime);
              }
            }
          }
        }
        
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(0, 0, width, height);
        
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 20) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        
        const mode = track.visMode || 'waveform';
        
        let refAnalyser = null;
        if (track.analyser && track.isPlaying) {
          refAnalyser = track.analyser;
        }

        
        if (mode === 'osc') {
          if (refAnalyser) {
            const bufferLength = refAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            refAnalyser.getByteTimeDomainData(dataArray);
            
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = trackColor;
            ctx.beginPath();
            
            const sliceWidth = width / bufferLength;
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
              const v = dataArray[i] / 128.0;
              const y = (v * height) / 2;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
              x += sliceWidth;
            }
            ctx.lineTo(width, height / 2);
            ctx.stroke();
          } else {
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
          }
        } else if (mode === 'spectrum') {
          if (refAnalyser) {
            const bufferLength = refAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            refAnalyser.getByteFrequencyData(dataArray);
            
            const numBars = 40;
            const barWidth = width / numBars;
            
            for (let i = 0; i < numBars; i++) {
              const dataIndex = Math.floor((i / numBars) * (bufferLength * 0.6));
              const val = dataArray[dataIndex] || 0;
              const barHeight = (val / 255) * height * 0.85;
              ctx.fillStyle = trackColor;
              ctx.fillRect(i * barWidth, height - barHeight, barWidth - 1.5, barHeight);
            }
          } else {
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
          }
        } else if (mode === 'waveform') {
          // SCROLLING AUDIO WAVEFORM (Audacity Smooth Style)
          if (track.staticWaveform && track.staticWaveform.length > 0) {
            let currentPct = 0;
            if (refAudio) {
              currentPct = refAudio.currentTime / duration;
            } else {
              const fill = document.getElementById(`progress-fill-${trackNum}`);
              if (fill && fill.style.width) {
                currentPct = parseFloat(fill.style.width) / 100;
              }
            }
            
            // Draw grid/background
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(0, 0, width, height);
            
            // Draw grid lines
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.lineWidth = 1;
            for (let x = 0; x < width; x += 40) {
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, height);
              ctx.stroke();
            }
            
            const visibleSeconds = 30; // Zoomed out as requested
            const zoomPercent = (visibleSeconds / 2) / duration;
            
            // Draw smooth Audacity-style waveform (Top and Bottom curves filled with gradient)
            function drawContinuousWaveform(startPixel, endPixel, colorType) {
              const grad = ctx.createLinearGradient(0, height * 0.075, 0, height * 0.925);
              if (colorType === 'played') {
                if (trackNum === 1) {
                  grad.addColorStop(0, '#00b38f');
                  grad.addColorStop(0.5, '#b3fff0');
                  grad.addColorStop(1, '#00b38f');
                } else {
                  grad.addColorStop(0, '#cc4400');
                  grad.addColorStop(0.5, '#ffccb3');
                  grad.addColorStop(1, '#cc4400');
                }
              } else {
                grad.addColorStop(0, '#2e2e2e');
                grad.addColorStop(0.5, '#5c5c5c');
                grad.addColorStop(1, '#2e2e2e');
              }

              ctx.fillStyle = grad;
              ctx.beginPath();
              
              let first = true;
              // Top half
              for (let pixelX = startPixel; pixelX <= endPixel; pixelX += 2) {
                const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
                if (pct >= 0 && pct <= 1) {
                  const waveformIndex = Math.floor(pct * track.staticWaveform.length);
                  const peak = track.staticWaveform[waveformIndex] || 0;
                  const h = Math.max(1, peak * height * 0.85);
                  const y = (height - h) / 2;
                  if (first) {
                    ctx.moveTo(pixelX, y);
                    first = false;
                  } else {
                    ctx.lineTo(pixelX, y);
                  }
                }
              }
              
              // Bottom half
              for (let pixelX = endPixel; pixelX >= startPixel; pixelX -= 2) {
                const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
                if (pct >= 0 && pct <= 1) {
                  const waveformIndex = Math.floor(pct * track.staticWaveform.length);
                  const peak = track.staticWaveform[waveformIndex] || 0;
                  const h = Math.max(1, peak * height * 0.85);
                  const y = (height + h) / 2;
                  ctx.lineTo(pixelX, y);
                }
              }
              
              ctx.closePath();
              ctx.fill();
            }
            
            // Draw played section (left of center playhead)
            drawContinuousWaveform(
              0,
              width / 2,
              track._waveformResetGraySettled ? 'unplayed' : 'played'
            );
            
            // Draw unplayed section (right of center playhead)
            drawContinuousWaveform(width / 2, width, 'unplayed');
            
            // Draw horizontal center line on top of the scrolling waveform (Audacity style)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();

            // Draw Rekordbox-style beat grid lines
            const beatDuration = 60 / track.bpmVal;
            const offset = track.beatOffset || 0;
            const leftTime = (currentPct - zoomPercent) * duration;
            const rightTime = (currentPct + zoomPercent) * duration;
            
            const firstVisibleBeat = Math.ceil((leftTime - offset) / beatDuration);
            const lastVisibleBeat = Math.floor((rightTime - offset) / beatDuration);
            
            for (let n = Math.max(0, firstVisibleBeat); n <= lastVisibleBeat; n++) {
              const beatTime = offset + n * beatDuration;
              const beatPct = beatTime / duration;
              const beatX = width / 2 + ((beatPct - currentPct) / zoomPercent) * (width / 2);
              
              if (n % 4 === 0) {
                // Downbeat (Red/orange line with bar number)
                ctx.strokeStyle = 'rgba(255, 0, 60, 0.45)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(beatX, 0);
                ctx.lineTo(beatX, height);
                ctx.stroke();
                
                ctx.fillStyle = 'rgba(255, 0, 60, 0.7)';
                ctx.font = '8px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(Math.floor(n / 4) + 1, beatX + 3, 10);
              } else {
                // Offbeat (White/grey line)
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(beatX, 0);
                ctx.lineTo(beatX, height);
                ctx.stroke();
                
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.font = '8px monospace';
                ctx.textAlign = 'left';
                ctx.fillText((n % 4) + 1, beatX + 3, height - 4);
              }
            }

            // Draw fixed center playhead (Red line with Rekordbox triangles)
            ctx.strokeStyle = '#ff003c';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(width / 2, 0);
            ctx.lineTo(width / 2, height);
            ctx.stroke();
            
            // Top playhead triangle marker
            ctx.fillStyle = '#ff003c';
            ctx.beginPath();
            ctx.moveTo(width / 2 - 5, 0);
            ctx.lineTo(width / 2 + 5, 0);
            ctx.lineTo(width / 2, 6);
            ctx.closePath();
            ctx.fill();
            
            // Bottom playhead triangle marker
            ctx.beginPath();
            ctx.moveTo(width / 2 - 5, height);
            ctx.lineTo(width / 2 + 5, height);
            ctx.lineTo(width / 2, height - 6);
            ctx.closePath();
            ctx.fill();
            
            // Highlight current loop boundaries on scrolling waveform
            if (hasValidTrackLoopRange(track)) {
              const startPct = track.loopStartTime / duration;
              const endPct = track.loopEndTime / duration;
              
              const startX = width / 2 + ((startPct - currentPct) / zoomPercent) * (width / 2);
              const endX = width / 2 + ((endPct - currentPct) / zoomPercent) * (width / 2);
              
              ctx.fillStyle = track.loopEnabled
                ? 'rgba(0, 255, 204, 0.15)'
                : 'rgba(145, 145, 145, 0.12)';
              ctx.fillRect(startX, 0, endX - startX, height);
              
              ctx.strokeStyle = track.loopEnabled ? '#00ffcc' : '#777777';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
              ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
              ctx.stroke();
            }
            
            // Highlight Play Whilst Holding active region on scrolling waveform
            if (track.activeHoldCueIdx !== null && track.hotCues && track.hotCues[track.activeHoldCueIdx] !== null) {
              const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
              const activeColor = hotCueColors[track.activeHoldCueIdx % hotCueColors.length];
              const cueTime = track.hotCues[track.activeHoldCueIdx];
              
              const startPct = Math.min(cueTime, refAudio.currentTime) / duration;
              const endPct = Math.max(cueTime, refAudio.currentTime) / duration;
              
              const startX = width / 2 + ((startPct - currentPct) / zoomPercent) * (width / 2);
              const endX = width / 2 + ((endPct - currentPct) / zoomPercent) * (width / 2);
              
              let r = parseInt(activeColor.slice(1, 3), 16);
              let g = parseInt(activeColor.slice(3, 5), 16);
              let b = parseInt(activeColor.slice(5, 7), 16);
              
              ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.25)`;
              ctx.fillRect(startX, 0, endX - startX, height);
              
              ctx.strokeStyle = activeColor;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
              ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
              ctx.stroke();
            }
            
            // Draw Hot Cues on scrolling waveform
            if (track.hotCues) {
              const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
              for (let i = 0; i < 8; i++) {
                const cueTime = track.hotCues[i];
                if (cueTime !== null) {
                  const cuePct = cueTime / duration;
                  const cueX = width / 2 + ((cuePct - currentPct) / zoomPercent) * (width / 2);
                  
                  if (cueX >= 0 && cueX <= width) {
                    const cueColor = hotCueColors[i % hotCueColors.length];
                    ctx.strokeStyle = cueColor;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(cueX, 0);
                    ctx.lineTo(cueX, height);
                    ctx.stroke();
                    
                    const text = `CUE ${i + 1}`;
                    ctx.font = 'bold 9px monospace';
                    const textWidth = ctx.measureText(text).width;
                    const rectWidth = textWidth + 8;
                    const rectHeight = 14;
                    
                    ctx.fillStyle = cueColor;
                    ctx.fillRect(cueX, height - rectHeight, rectWidth, rectHeight);
                    
                    ctx.fillStyle = '#111';
                    ctx.textAlign = 'left';
                    ctx.fillText(text, cueX + 4, height - 4);
                  }
                }
              }
            }
          } else {
            ctx.fillStyle = '#666';
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText("NO AUDIO FILE LOADED", width / 2, height / 2 + 3);
          }
        }

        if (notoMixerConfig.showAudioLevel && track.analyser) {
          const bufferLength = track.analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          track.analyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0 - 1.0;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / bufferLength);
          let level = Math.min(1, rms * 3.5);
          const vuCover = document.getElementById(`vu-bar-t${trackNum}-cover`);
          if (vuCover) {
            vuCover.style.width = (100 - level * 100) + '%';
          }
        }

      } catch (err) {
        console.error("Track visualizer draw error:", err);
      }
    }
    
    draw();
  });
}

// Adds dynamic vertical drag physics to custom knobs
function setupKnobDrag(trackNum, param) {
  const wrapper = document.getElementById(`knob-${param}-${trackNum}-wrapper`);
  const slider = document.getElementById(`${param}-${trackNum}`);
  if (!wrapper || !slider) return;

  let isDragging = false;
  let startY = 0;
  let startValue = 0;

  // Determine center snap target if applicable
  let snapTarget = null;
  if (['bass', 'low', 'treb', 'pitch', 'pan'].includes(param)) {
    snapTarget = 0;
  } else if (param === 'filter') {
    snapTarget = 50;
  } else if (param === 'speed') {
    snapTarget = 100;
  }

  wrapper.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startY = e.clientY;
    startValue = parseFloat(slider.value);
    
    // Add temp listeners to window to support dragging outside the bounds
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault(); // Prevent text highlights
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const deltaY = startY - e.clientY; // drag up increases
    
    const rangePixels = 100; // sensitivity
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const range = max - min;
    
    let newVal = startValue + (deltaY / rangePixels) * range;
    newVal = Math.max(min, Math.min(max, newVal));
    
    // Apply center snap if enabled and parameter is eligible
    if (snapEnabled && snapTarget !== null) {
      const thresholdVal = (snapThresholdPct / 100) * range;
      if (Math.abs(newVal - snapTarget) <= thresholdVal) {
        newVal = snapTarget;
      }
    }
    
    slider.value = newVal;
    
    // Fire the input event on the slider
    slider.dispatchEvent(new Event('input'));
  }

  function onMouseUp() {
    isDragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }
}

// Allows vertical dragging of the % symbol to adjust volume
function setupVolumePercentDrag(trackNum) {
  const percentSymbol = document.querySelector(`#track-${trackNum} .vol-percent-symbol`);
  if (!percentSymbol) return;

  percentSymbol.style.cursor = 'ns-resize';
  percentSymbol.style.userSelect = 'none';

  let isDragging = false;
  let startY = 0;
  let startVal = 80;

  percentSymbol.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startY = e.clientY;
    startVal = parseInt(document.getElementById(`vol-${trackNum}`).value) || 80;

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const deltaY = startY - e.clientY; // Drag up increases
    const sensitivity = 0.6; // Scale sensitivity
    let newVal = startVal + deltaY * sensitivity;
    newVal = Math.max(0, Math.min(100, Math.round(newVal)));
    setVolume(trackNum, newVal);
  }

  function onMouseUp() {
    isDragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }
}

function startUdpServer() {
  try {
    const dgram = require('dgram');
    const server = dgram.createSocket('udp4');
    
    server.on('error', (err) => {
      logConsole(`UDP Server Error: ${err.message}`, 'err');
      try { server.close(); } catch(e){}
    });
    
    server.on('message', (msg, rinfo) => {
      esp32Ip = rinfo.address; // Save the IP of the ESP32
      const data = msg.toString().trim();
      const lines = data.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          parseIncomingMessage(line.trim());
        }
      });
    });
    
    server.on('listening', () => {
      const address = server.address();
      logConsole(`UDP Server listening on port ${address.port}`, 'system');
      
      // No connection status UI update for UDP server
    });
    
    server.bind(esp32Port);
    window.udpSocket = server;
  } catch (err) {
    logConsole(`UDP Initialization error: ${err.message}`, 'err');
  }
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  initializeEmptySoundButtonLabels();
  const appVersionLabel = document.getElementById('settings-app-version');
  if (appVersionLabel) {
    appVersionLabel.textContent = notoMixerConfig.version;
  }
  loadSnapSettings(); // Load snap settings from local storage
  loadMusicSettings(); // Load silence skipping preferences
  loadLayoutSettings(); // Load layout settings from local storage
  loadZoomSettings(); // Load zoom settings from local storage
  loadKeyboardBindings();
  loadMidiControllerConfig();
  loadJogPhysicsSettings();
  populateKeyboardBindingInputs();
  setupMacroUI();
  setupLoopSettingsContextMenu();
  setupUIListeners();
  setupKeyboardShortcuts();
  setupMidiControllerUI();
  setupTabletControllerExtension();
  setupAppUpdateUI();
  initMidiControllers();
  setupEndSyncModalListeners();
  startVisualizers();
  
  document.getElementById('btn-refresh-ports').addEventListener('click', scanPorts);
  document.getElementById('btn-connect').addEventListener('click', toggleConnection);
  
  // Initialize all controls with standard values
  [1, 2].forEach(trackNum => {
    setVolume(trackNum, 80);
    ['bass', 'low', 'treb', 'pitch', 'pan', 'reverb'].forEach(param => updateKnobUI(trackNum, param, 0));
    ['inst', 'voc', 'speed'].forEach(param => updateKnobUI(trackNum, param, 100));
    updateKnobUI(trackNum, 'echo', 0);
    updateKnobUI(trackNum, 'filter', 50);
    updateKnobUI(trackNum, 'echotime', 350);
    setBPM(trackNum, 120);
    setBPMDiv(trackNum, '1/1');

    const savedEndSyncSeconds = Number(localStorage.getItem(`notoMixer_endSyncSeconds_${trackNum}`));
    if (Number.isFinite(savedEndSyncSeconds) && savedEndSyncSeconds >= 1) {
      tracks[trackNum].endSyncSeconds = Math.min(600, Math.round(savedEndSyncSeconds));
    }
    const savedEndSyncMixEnabled =
      localStorage.getItem(`notoMixer_endSyncMixEnabled_${trackNum}`);
    const savedEndSyncMixSeconds =
      Number(localStorage.getItem(`notoMixer_endSyncMixSeconds_${trackNum}`));
    tracks[trackNum].endSyncMixEnabled = savedEndSyncMixEnabled === 'true';
    if (Number.isFinite(savedEndSyncMixSeconds) && savedEndSyncMixSeconds >= 1) {
      tracks[trackNum].endSyncMixSeconds =
        Math.min(600, Math.round(savedEndSyncMixSeconds));
    }
    tracks[trackNum].endSyncFadeInEnabled =
      localStorage.getItem(`notoMixer_endSyncFadeInEnabled_${trackNum}`) === 'true';
    tracks[trackNum].endSyncFadeOutEnabled =
      localStorage.getItem(`notoMixer_endSyncFadeOutEnabled_${trackNum}`) === 'true';
    const savedEndSyncFadeSeconds =
      Number(localStorage.getItem(`notoMixer_endSyncFadeSeconds_${trackNum}`));
    if (Number.isFinite(savedEndSyncFadeSeconds) && savedEndSyncFadeSeconds >= 1) {
      tracks[trackNum].endSyncFadeSeconds =
        Math.min(600, Math.round(savedEndSyncFadeSeconds));
    }
    updateTrackPlatterCover(trackNum);
    updateTrackPlatterPosition(trackNum, 0);
    updateEndSyncButton(trackNum);
    
    // Bind vertical drag physics to SVG knobs
    ['bass', 'low', 'treb', 'inst', 'voc', 'pitch', 'speed', 'echo', 'filter', 'pan', 'reverb', 'echotime'].forEach(param => {
      setupKnobDrag(trackNum, param);
    });
    setupVolumePercentDrag(trackNum);
  });
  
  // Proactive: Restore previously selected working directory if saved
  const savedDir = localStorage.getItem('notoMixer_workingDir');
  if (savedDir) {
    workingDir = savedDir;
    workingDirectoryAvailable = null;
    updateWorkingDirectoryLabel();
    refreshWorkingDirectoryAvailability();
  } else {
    renderMediaSupportAvailability(false);
    releaseInitialSongAnalyzerGate();
  }
  startWorkingDirectoryMonitor();
  
  // Modal Buttons listeners
  const btnRetry = document.getElementById('modal-btn-retry');
  if (btnRetry) {
    btnRetry.addEventListener('click', async () => {
      hideConnectionModal();
      try {
        await scanPorts();
        if (!activePort) {
          showConnectionModal();
        } else {
          maybeShowEvaluationNotice();
        }
      } catch (err) {
        showConnectionModal();
      }
    });
  }

  const btnBypass = document.getElementById('modal-btn-bypass');
  if (btnBypass) {
    btnBypass.addEventListener('click', () => {
      hideConnectionModal();
      logConsole("Info: Using app in standalone mode (without notoMixer)", 'system');
      maybeShowEvaluationNotice();
    });
  }

  const evaluationConfirmButton = document.getElementById('evaluation-btn-confirm');
  if (evaluationConfirmButton) {
    evaluationConfirmButton.addEventListener('click', hideEvaluationNotice);
  }

  // Settings Button and Modal listeners
  const btnOpenSettings = document.getElementById('btn-open-settings');
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener('click', () => {
      showSettingsModal();
    });
  }

  // BPM Filter Toggle Button
  const btnBpmFilter = document.getElementById('btn-bpm-filter');
  if (btnBpmFilter) {
    btnBpmFilter.dataset.track = '1';
    btnBpmFilter.addEventListener('click', () => {
      bpmFilterTrack = bpmFilterTrack === 1 ? 2 : 1;
      const trackNumSpan = document.getElementById('bpm-filter-track-num');
      if (trackNumSpan) trackNumSpan.textContent = bpmFilterTrack;
      btnBpmFilter.dataset.track = String(bpmFilterTrack);
      updateBpmCompatIndicators();
    });
  }

  // Search bar input
  const songSearchInput = document.getElementById('song-search-input');
  if (songSearchInput) {
    songSearchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value;
      applySongListFilters();
    });
  }

  // Status Filter button
  const btnStatusFilter = document.getElementById('btn-status-filter');
  if (btnStatusFilter) {
    btnStatusFilter.addEventListener('click', () => {
      // Cycle: ALL -> ✓ -> ⚠ -> ✗ -> ALL
      if (currentStatusFilter === 'ALL') {
        currentStatusFilter = '✓';
        btnStatusFilter.style.color = '#00ffcc';
        btnStatusFilter.style.borderColor = '#00ffcc';
      } else if (currentStatusFilter === '✓') {
        currentStatusFilter = '⚠';
        btnStatusFilter.style.color = '#ffcc00';
        btnStatusFilter.style.borderColor = '#ffcc00';
      } else if (currentStatusFilter === '⚠') {
        currentStatusFilter = '✗';
        btnStatusFilter.style.color = '#ff3333';
        btnStatusFilter.style.borderColor = '#ff3333';
      } else {
        currentStatusFilter = 'ALL';
        btnStatusFilter.style.color = 'white';
        btnStatusFilter.style.borderColor = 'var(--border-light)';
      }
      btnStatusFilter.textContent = currentStatusFilter;
      applySongListFilters();
    });
  }

  const btnCloseSettings = document.getElementById('settings-btn-close');
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      // Revert settings changes in UI to current saved state
      const snapCheck = document.getElementById('setting-snap-enable');
      const snapSlider = document.getElementById('setting-snap-threshold');
      const snapDisplay = document.getElementById('snap-threshold-display');
      
      if (snapCheck) snapCheck.checked = snapEnabled;
      if (snapSlider) {
        snapSlider.value = snapThresholdPct;
        if (snapDisplay) snapDisplay.textContent = `${snapThresholdPct}%`;
      }

      const openingSilenceCheck = document.getElementById('setting-skip-opening-silence');
      const endingSilenceCheck = document.getElementById('setting-skip-ending-silence');
      const endingWarningCheck = document.getElementById('setting-music-ending-warning');
      if (openingSilenceCheck) openingSilenceCheck.checked = skipOpeningSilence;
      if (endingSilenceCheck) endingSilenceCheck.checked = skipEndingSilence;
      if (endingWarningCheck) endingWarningCheck.checked = musicEndingWarning;
      populateKeyboardBindingInputs();
      loadJogPhysicsSettings();
      populateJogPhysicsSettingsUI();
      publishTabletControllerState(true);

      const mainSelect = document.getElementById('setting-main-audio');
      const previewSelect = document.getElementById('setting-preview-audio');
      const savedMain = localStorage.getItem('notoMixer_mainAudioDevice');
      const savedPreview = localStorage.getItem('notoMixer_previewAudioDevice');
      if (mainSelect && savedMain) mainSelect.value = savedMain;
      if (previewSelect && savedPreview) previewSelect.value = savedPreview;
      
      const layoutSelect = document.getElementById('setting-layout-mode');
      if (layoutSelect) layoutSelect.value = layoutMode;
      // Revert Zoom changes in UI and DOM
      const zoomTextSlider = document.getElementById('setting-zoom-text');
      const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
      const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
      const zoomCoverSlider = document.getElementById('setting-zoom-cover');
      
      if (zoomTextSlider) zoomTextSlider.value = zoomText;
      if (zoomWaveformSlider) zoomWaveformSlider.value = zoomWaveform;
      if (zoomButtonsSlider) zoomButtonsSlider.value = zoomButtons;
      if (zoomCoverSlider) zoomCoverSlider.value = zoomCover;
      
      applyZoomSettings();
      
      hideSettingsModal();
    });
  }

  const btnSaveSettings = document.getElementById('settings-btn-save');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      const snapCheck = document.getElementById('setting-snap-enable');
      const snapSlider = document.getElementById('setting-snap-threshold');
      
      if (snapCheck) {
        snapEnabled = snapCheck.checked;
        localStorage.setItem('notoMixer_snapEnabled', snapEnabled ? 'true' : 'false');
      }
      if (snapSlider) {
        snapThresholdPct = parseInt(snapSlider.value) || 5;
        localStorage.setItem('notoMixer_snapThreshold', snapThresholdPct);
      }

      const openingSilenceCheck = document.getElementById('setting-skip-opening-silence');
      const endingSilenceCheck = document.getElementById('setting-skip-ending-silence');
      const endingWarningCheck = document.getElementById('setting-music-ending-warning');
      const previousSkipEndingSilence = skipEndingSilence;

      if (openingSilenceCheck) {
        skipOpeningSilence = openingSilenceCheck.checked;
        localStorage.setItem(
          'notoMixer_skipOpeningSilence',
          skipOpeningSilence ? 'true' : 'false'
        );
      }
      if (endingSilenceCheck) {
        skipEndingSilence = endingSilenceCheck.checked;
        localStorage.setItem(
          'notoMixer_skipEndingSilence',
          skipEndingSilence ? 'true' : 'false'
        );
      }
      if (endingWarningCheck) {
        musicEndingWarning = endingWarningCheck.checked;
        localStorage.setItem(
          'notoMixer_musicEndingWarning',
          musicEndingWarning ? 'true' : 'false'
        );
      }

      document
        .querySelectorAll('.keybind-capture-input[data-keybind-action]')
        .forEach(input => {
          keyboardBindings[input.dataset.keybindAction] =
            input.dataset.code || '';
        });
      localStorage.setItem(
        'notoMixer_keyboardBindings',
        JSON.stringify(keyboardBindings)
      );

      const jogMaxSpeedSlider = document.getElementById(
        'setting-jog-max-speed'
      );
      const jogInertiaSlider = document.getElementById('setting-jog-inertia');
      if (jogMaxSpeedSlider) {
        jogMaxSpeed = clampJogMaxSpeed(jogMaxSpeedSlider.value);
        localStorage.setItem('notoMixer_jogMaxSpeed', String(jogMaxSpeed));
      }
      if (jogInertiaSlider) {
        jogInertiaSeconds = clampJogInertiaSeconds(jogInertiaSlider.value);
        localStorage.setItem(
          'notoMixer_jogInertiaSeconds',
          String(jogInertiaSeconds)
        );
      }
      publishTabletControllerState(true);

      if (previousSkipEndingSilence !== skipEndingSilence) {
        [1, 2].forEach(trackNum => {
          if (tracks[trackNum].endSyncRampStarted) {
            resetEndSyncRamp(trackNum, true);
          }
        });
      }

      const mainSelect = document.getElementById('setting-main-audio');
      const previewSelect = document.getElementById('setting-preview-audio');
      if (mainSelect) {
        localStorage.setItem('notoMixer_mainAudioDevice', mainSelect.value);
        if (audioCtx && typeof audioCtx.setSinkId === 'function') {
          audioCtx.setSinkId(mainSelect.value === 'default' ? '' : mainSelect.value)
            .catch(err => {
              console.error("Error setting main sink ID on save, falling back to default:", err);
              audioCtx.setSinkId('');
            });
        }
      }
      if (previewSelect) {
        localStorage.setItem('notoMixer_previewAudioDevice', previewSelect.value);
        if (previewAudioCtx && typeof previewAudioCtx.setSinkId === 'function') {
          previewAudioCtx.setSinkId(previewSelect.value === 'default' ? '' : previewSelect.value)
            .catch(err => {
              console.error("Error setting preview sink ID on save, falling back to default:", err);
              previewAudioCtx.setSinkId('');
            });
        }
      }
      
      const layoutSelect = document.getElementById('setting-layout-mode');
      if (layoutSelect) {
        const newLayout = layoutSelect.value || 'default';
        localStorage.setItem('notoMixer_layoutMode', newLayout);
        applyLayoutMode(newLayout);
      }

      // Save zoom settings
      const zoomTextSlider = document.getElementById('setting-zoom-text');
      if (zoomTextSlider) {
        zoomText = parseInt(zoomTextSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomText', zoomText);
      }
      const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
      if (zoomWaveformSlider) {
        zoomWaveform = parseInt(zoomWaveformSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomWaveform', zoomWaveform);
      }
      const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
      if (zoomButtonsSlider) {
        zoomButtons = parseInt(zoomButtonsSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomButtons', zoomButtons);
      }
      const zoomCoverSlider = document.getElementById('setting-zoom-cover');
      if (zoomCoverSlider) {
        zoomCover = parseInt(zoomCoverSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomCover', zoomCover);
      }
      applyZoomSettings();
      persistUserSettings();

      [1, 2].forEach(trackNum => {
        if (tracks[trackNum].isPlaying) {
          skipOpeningSilenceIfNeeded(trackNum);
          handleTrackProgress(trackNum);
          updateEndSync(trackNum);
        }
      });

      hideSettingsModal();
      logConsole("Info: Settings saved successfully", 'system');
    });
  }

  // Settings Tab Switching Logic
  const settingsMenuItems = document.querySelectorAll('.settings-menu-item');
  settingsMenuItems.forEach(item => {
    item.addEventListener('click', () => {
      // Deactivate all tab menu items
      settingsMenuItems.forEach(menuItem => menuItem.classList.remove('active'));
      
      // Hide all tab contents
      document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.classList.remove('active');
      });
      
      // Activate clicked item
      item.classList.add('active');
      
      // Show corresponding tab content
      const tabId = item.getAttribute('data-tab');
      const targetTab = document.getElementById(`tab-${tabId}`);
      if (targetTab) {
        targetTab.classList.add('active');
      }
      if (tabId === 'controllers') {
        initMidiControllers();
      }
    });
  });

  // Settings UI Initialization and Listeners
  const layoutSelect = document.getElementById('setting-layout-mode');
  if (layoutSelect) {
    layoutSelect.value = layoutMode;
  }
  const snapCheck = document.getElementById('setting-snap-enable');
  const snapSlider = document.getElementById('setting-snap-threshold');
  const snapDisplay = document.getElementById('snap-threshold-display');
  const openingSilenceCheck = document.getElementById('setting-skip-opening-silence');
  const endingSilenceCheck = document.getElementById('setting-skip-ending-silence');
  const endingWarningCheck = document.getElementById('setting-music-ending-warning');
  const jogMaxSpeedSlider = document.getElementById('setting-jog-max-speed');
  const jogMaxSpeedDisplay = document.getElementById('jog-max-speed-display');
  const jogInertiaSlider = document.getElementById('setting-jog-inertia');
  const jogInertiaDisplay = document.getElementById('jog-inertia-display');
  
  if (snapCheck) {
    snapCheck.checked = snapEnabled;
  }
  if (snapSlider) {
    snapSlider.value = snapThresholdPct;
    snapSlider.addEventListener('input', () => {
      if (snapDisplay) {
        snapDisplay.textContent = `${snapSlider.value}%`;
      }
    });
  }
  if (snapDisplay) {
    snapDisplay.textContent = `${snapThresholdPct}%`;
  }
  if (openingSilenceCheck) {
    openingSilenceCheck.checked = skipOpeningSilence;
  }
  if (endingSilenceCheck) {
    endingSilenceCheck.checked = skipEndingSilence;
  }
  if (endingWarningCheck) {
    endingWarningCheck.checked = musicEndingWarning;
  }
  populateJogPhysicsSettingsUI();
  if (jogMaxSpeedSlider) {
    jogMaxSpeedSlider.addEventListener('input', () => {
      jogMaxSpeed = clampJogMaxSpeed(jogMaxSpeedSlider.value);
      if (jogMaxSpeedDisplay) {
        jogMaxSpeedDisplay.textContent =
          `${Math.round(jogMaxSpeed)}×`;
      }
      publishTabletControllerState(true);
    });
  }
  if (jogInertiaSlider) {
    jogInertiaSlider.addEventListener('input', () => {
      jogInertiaSeconds = clampJogInertiaSeconds(jogInertiaSlider.value);
      if (jogInertiaDisplay) {
        jogInertiaDisplay.textContent =
          `${jogInertiaSeconds.toFixed(2)} s`;
      }
      publishTabletControllerState(true);
    });
  }

  // Try to connect automatically if we have previously authorized ports (no click needed)
  if (navigator.serial) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (activePort && event.port === activePort) {
        handleDeviceLost();
      }
    });
  }

  // Start the background scanner for COM port connections
  startAutoConnectScanner();
  
  // Show connection modal if not connected (give scanner a tiny moment to run first)
  setTimeout(() => {
    if (!activePort) {
      showConnectionModal();
    }
    initialMixerCheckComplete = true;
    maybeShowEvaluationNotice();
  }, 150);

  // Live Zoom adjustments
  const zoomTextSlider = document.getElementById('setting-zoom-text');
  if (zoomTextSlider) {
    zoomTextSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-text-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-text', val / 100);
    });
  }

  const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
  if (zoomWaveformSlider) {
    zoomWaveformSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-waveform-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-waveform', val / 100);
    });
  }

  const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
  if (zoomButtonsSlider) {
    zoomButtonsSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-buttons-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-buttons', val / 100);
    });
  }

  const zoomCoverSlider = document.getElementById('setting-zoom-cover');
  if (zoomCoverSlider) {
    zoomCoverSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-cover-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-cover-scale', val / 100);
    });
  }

  // Initialize the draggable preview panel
  initInAppPreview();
  startUdpServer(); // Start the UDP Server automatically
});

// -------------------------------------------------------------
// In-App Draggable Preview Panel System
// -------------------------------------------------------------

let previewAudioCtx = null;
let previewIsPlaying = false;
let previewVisMode = 'waveform';

// EQ/FX Parameter Values for Preview
let prevBassVal = 0;
let prevLowVal = 0;
let prevTrebVal = 0;
let prevInstVal = 100;
let prevVocVal = 100;
let prevFilterVal = 50;
let prevPitchVal = 0;
let prevSpeedVal = 1.0;
let prevEchoVal = 0;
let prevPanVal = 0;
let prevReverbVal = 0;
let prevEchoTimeVal = 350;
let prevVolVal = 80;
let previewSongPath = '';

// Metronome and Tempo State for Preview
let prevBpmVal = 120;
let prevBeatOffset = 0;
let prevBpmDivVal = '1/1';
let prevMetronomeOn = false;
let prevMetronomeIntervalId = null;

// Loop State for Preview
let prevLoopEnabled = false;
let prevLoopRepeatEnabled = true;
let prevLoopExitAction = 'continue';
let prevLoopStartTime = null;
let prevLoopEndTime = null;
let prevAutoLoopBeats = 4;

// Combined Static Waveform for Preview
let previewStaticWaveform = null;

// Audio Nodes for Preview
let prevBassFilter = null;
let prevLowFilter = null;
let prevTrebFilter = null;
let prevFilterLPFNode = null;
let prevFilterHPFNode = null;
let prevGainNode = null;
let prevPanNode = null;
let prevReverbConvolverNode = null;
let prevReverbWetNode = null;
let prevAnalyser = null;
let prevEchoDelayNode = null;
let prevEchoFeedbackNode = null;
let prevEchoWetNode = null;
let prevPitchShifter = null;

// Stems Data for Preview
const previewStems = {
  main: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'main.mp3' },
  vocals: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'vocals.mp3' },
  inst: { audios: [], exists: false }
};

// Sound Sampler Buttons Data for Preview
const previewSoundButtons = [
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null }
];
const previewSampleModes = Array(8).fill('ontop');
const previewActiveSampleSources = Array.from({ length: 8 }, () => new Set());

function stopPreviewSampleEffect(buttonIndex, { logStop = false } = {}) {
  const activeSources = previewActiveSampleSources[buttonIndex];
  if (!activeSources) return false;
  const hadActiveSources = activeSources.size > 0;
  activeSources.forEach(sourceNode => {
    try { sourceNode.stop(); } catch (error) {}
    try { sourceNode.disconnect(); } catch (error) {}
  });
  activeSources.clear();
  document.getElementById(`prev-sound-btn-${buttonIndex}`)
    ?.classList.remove('playing');
  if (hadActiveSources && logStop) {
    logConsole(`Effect: Stopped Preview button ${buttonIndex + 1}`, 'system');
  }
  return hadActiveSources;
}

function playPreviewSampleEffect(buttonIndex, button) {
  const soundData = previewSoundButtons[buttonIndex];
  if (!soundData?.buffer) return false;
  initPreviewAudio();
  if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
  if (previewSampleModes[buttonIndex] === 'restart') {
    stopPreviewSampleEffect(buttonIndex);
  }

  try {
    const sourceNode = previewAudioCtx.createBufferSource();
    const activeSources = previewActiveSampleSources[buttonIndex];
    sourceNode.buffer = soundData.buffer;
    sourceNode.connect(previewAudioCtx.destination);
    activeSources.add(sourceNode);
    button.classList.add('playing');
    sourceNode.onended = () => {
      activeSources.delete(sourceNode);
      try { sourceNode.disconnect(); } catch (error) {}
      if (activeSources.size === 0) button.classList.remove('playing');
    };
    sourceNode.start(0);
    return true;
  } catch (error) {
    logConsole(`Err: Failed to play preview effect: ${error.message}`, 'err');
    return false;
  }
}

function clearPreviewSampleEffect(buttonIndex) {
  stopPreviewSampleEffect(buttonIndex);
  previewSampleModes[buttonIndex] = 'ontop';
  previewSoundButtons[buttonIndex] = {
    path: '',
    name: 'DROP FILE',
    buffer: null
  };
  const button = document.getElementById(`prev-sound-btn-${buttonIndex}`);
  if (!button) return;
  renderEmptySoundButtonLabel(button);
  button.classList.remove('loaded', 'playing');
  button.title = '';
}

function makeElementDraggable(el, header) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  header.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    if (e.target.id === 'preview-panel-close-btn') return;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    let newTop = el.offsetTop - pos2;
    let newLeft = el.offsetLeft - pos1;
    
    // Constrain to window bounds
    newTop = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, newTop));
    newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, newLeft));
    
    el.style.top = newTop + "px";
    el.style.left = newLeft + "px";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

function makeElementResizable(el) {
  const handles = el.querySelectorAll('.resize-handle');
  
  handles.forEach(handle => {
    handle.addEventListener('mousedown', initResize);
  });

  function initResize(e) {
    e.preventDefault();
    const handle = e.target;
    let startX = e.clientX;
    let startY = e.clientY;
    let startWidth = el.offsetWidth;
    let startHeight = el.offsetHeight;
    let startLeft = el.offsetLeft;
    let startTop = el.offsetTop;

    const minWidth = 320;
    const minHeight = 500;
    const maxWidth = 700;
    const maxHeight = 950;

    function resize(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let newLeft = startLeft;
      let newTop = startTop;

      if (handle.classList.contains('right')) {
        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + dx));
      }
      if (handle.classList.contains('left')) {
        const targetWidth = startWidth - dx;
        if (targetWidth >= minWidth && targetWidth <= maxWidth) {
          newWidth = targetWidth;
          newLeft = startLeft + dx;
        }
      }
      if (handle.classList.contains('bottom')) {
        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      }
      if (handle.classList.contains('top')) {
        const targetHeight = startHeight - dy;
        if (targetHeight >= minHeight && targetHeight <= maxHeight) {
          newHeight = targetHeight;
          newTop = startTop + dy;
        }
      }
      
      if (handle.classList.contains('top-left')) {
        const targetWidth = startWidth - dx;
        const targetHeight = startHeight - dy;
        if (targetWidth >= minWidth && targetWidth <= maxWidth) {
          newWidth = targetWidth;
          newLeft = startLeft + dx;
        }
        if (targetHeight >= minHeight && targetHeight <= maxHeight) {
          newHeight = targetHeight;
          newTop = startTop + dy;
        }
      }
      if (handle.classList.contains('top-right')) {
        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + dx));
        const targetHeight = startHeight - dy;
        if (targetHeight >= minHeight && targetHeight <= maxHeight) {
          newHeight = targetHeight;
          newTop = startTop + dy;
        }
      }
      if (handle.classList.contains('bottom-left')) {
        const targetWidth = startWidth - dx;
        if (targetWidth >= minWidth && targetWidth <= maxWidth) {
          newWidth = targetWidth;
          newLeft = startLeft + dx;
        }
        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      }
      if (handle.classList.contains('bottom-right')) {
        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + dx));
        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      }

      el.style.width = newWidth + 'px';
      el.style.height = newHeight + 'px';
      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
    }

    function stopResize() {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResize);
    }

    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResize);
  }
}

function initPreviewAudio() {
  if (previewAudioCtx) return;
  previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  
  const savedPreview = localStorage.getItem('notoMixer_previewAudioDevice');
  if (savedPreview && savedPreview !== 'default' && typeof previewAudioCtx.setSinkId === 'function') {
    previewAudioCtx.setSinkId(savedPreview).catch(err => {
      console.error("Error setting preview sink ID, falling back to default:", err);
      previewAudioCtx.setSinkId('');
    });
  }
  
  prevBassFilter = previewAudioCtx.createBiquadFilter();
  prevBassFilter.type = 'peaking';
  prevBassFilter.frequency.value = 80;
  prevBassFilter.Q.value = 1.0;
  prevBassFilter.gain.value = prevBassVal;
  
  prevLowFilter = previewAudioCtx.createBiquadFilter();
  prevLowFilter.type = 'peaking';
  prevLowFilter.frequency.value = 320;
  prevLowFilter.Q.value = 1.0;
  prevLowFilter.gain.value = prevLowVal;
  
  prevTrebFilter = previewAudioCtx.createBiquadFilter();
  prevTrebFilter.type = 'peaking';
  prevTrebFilter.frequency.value = 3000;
  prevTrebFilter.Q.value = 1.0;
  prevTrebFilter.gain.value = prevTrebVal;
  
  prevFilterLPFNode = previewAudioCtx.createBiquadFilter();
  prevFilterLPFNode.type = 'lowpass';
  prevFilterLPFNode.frequency.value = 22000;
  
  prevFilterHPFNode = previewAudioCtx.createBiquadFilter();
  prevFilterHPFNode.type = 'highpass';
  prevFilterHPFNode.frequency.value = 20;
  
  prevGainNode = previewAudioCtx.createGain();
  prevGainNode.gain.value = prevVolVal / 100;
  
  prevPanNode = previewAudioCtx.createStereoPanner();
  prevPanNode.pan.value = prevPanVal / 100;
  
  prevReverbConvolverNode = previewAudioCtx.createConvolver();
  prevReverbConvolverNode.buffer = createReverbImpulseResponse(2.0, 2.0, previewAudioCtx.sampleRate);
  prevReverbWetNode = previewAudioCtx.createGain();
  prevReverbWetNode.gain.value = (prevReverbVal / 100) * 0.8;
  
  prevEchoDelayNode = previewAudioCtx.createDelay(2.0);
  prevEchoDelayNode.delayTime.value = prevEchoTimeVal / 1000;
  
  prevEchoFeedbackNode = previewAudioCtx.createGain();
  prevEchoFeedbackNode.gain.value = (prevEchoVal / 100) * 0.7;
  
  prevEchoWetNode = previewAudioCtx.createGain();
  prevEchoWetNode.gain.value = prevEchoVal / 100;
  
  prevAnalyser = previewAudioCtx.createAnalyser();
  prevAnalyser.fftSize = 256;
  
  prevPitchShifter = new PitchShifterNode(previewAudioCtx);
  prevPitchShifter.setPitch(Math.pow(2, prevPitchVal / 12));
  
  previewStems.main.gainNode = previewAudioCtx.createGain();
  previewStems.main.gainNode.gain.value = 1.0;
  previewStems.vocals.gainNode = previewAudioCtx.createGain();
  previewStems.vocals.gainNode.gain.value = prevVocVal / 100;
  previewStems.inst.gainNode = previewAudioCtx.createGain();
  previewStems.inst.gainNode.gain.value = prevInstVal / 100;
  
  previewStems.main.gainNode.connect(prevBassFilter);
  previewStems.vocals.gainNode.connect(prevBassFilter);
  previewStems.inst.gainNode.connect(prevBassFilter);
  
  prevBassFilter.connect(prevLowFilter);
  prevLowFilter.connect(prevTrebFilter);
  prevTrebFilter.connect(prevFilterLPFNode);
  prevFilterLPFNode.connect(prevFilterHPFNode);
  
  prevEchoDelayNode.connect(prevEchoFeedbackNode);
  prevEchoFeedbackNode.connect(prevEchoDelayNode);
  
  prevEchoDelayNode.connect(prevEchoWetNode);
  prevEchoWetNode.connect(prevGainNode);
  
  prevGainNode.connect(prevPanNode);
  
  prevGainNode.connect(prevReverbConvolverNode);
  prevReverbConvolverNode.connect(prevReverbWetNode);
  prevReverbWetNode.connect(prevPanNode);
  
  prevPanNode.connect(prevAnalyser);
  prevAnalyser.connect(previewAudioCtx.destination);
  
  updatePreviewAudioGraphConnections();
  applyPreviewFilters();
}

function updatePreviewAudioGraphConnections() {
  if (!previewAudioCtx) return;
  
  try {
    prevFilterHPFNode.disconnect();
  } catch(e) {}
  try {
    prevPitchShifter.node.disconnect();
  } catch(e) {}
  
  const isPitchActive = (Math.abs(Number(prevPitchVal)) > 0.05);
  
  if (isPitchActive) {
    prevPitchShifter.node.onaudioprocess = prevPitchShifter.process;
    prevFilterHPFNode.connect(prevPitchShifter.node);
    prevPitchShifter.node.connect(prevGainNode);
    prevPitchShifter.node.connect(prevEchoDelayNode);
  } else {
    prevPitchShifter.node.onaudioprocess = null;
    prevFilterHPFNode.connect(prevGainNode);
    prevFilterHPFNode.connect(prevEchoDelayNode);
  }
}

function applyPreviewFilters() {
  if (!previewAudioCtx) return;
  const time = previewAudioCtx.currentTime;
  
  prevBassFilter.gain.setValueAtTime(prevBassVal, time);
  prevLowFilter.gain.setValueAtTime(prevLowVal, time);
  prevTrebFilter.gain.setValueAtTime(prevTrebVal, time);
  
  previewStems.vocals.gainNode.gain.setValueAtTime(prevVocVal / 100, time);
  previewStems.inst.gainNode.gain.setValueAtTime(prevInstVal / 100, time);
  
  if (prevFilterVal === 50) {
    prevFilterLPFNode.frequency.setValueAtTime(22000, time);
    prevFilterHPFNode.frequency.setValueAtTime(20, time);
  } else if (prevFilterVal < 50) {
    const pct = prevFilterVal / 50;
    const freq = 200 + pct * 21800;
    prevFilterLPFNode.frequency.setValueAtTime(freq, time);
    prevFilterHPFNode.frequency.setValueAtTime(20, time);
  } else {
    const pct = (prevFilterVal - 50) / 50;
    const freq = 20 + pct * 4000;
    prevFilterLPFNode.frequency.setValueAtTime(22000, time);
    prevFilterHPFNode.frequency.setValueAtTime(freq, time);
  }
  
  updatePreviewAudioGraphConnections();
  prevPitchShifter.setPitch(Math.pow(2, prevPitchVal / 12));
  
  previewStems.main.audio.playbackRate = prevSpeedVal;
  previewStems.vocals.audio.playbackRate = prevSpeedVal;
  previewStems.inst.audios.forEach(item => {
    item.audio.playbackRate = prevSpeedVal;
  });
  
  prevEchoWetNode.gain.setValueAtTime(prevEchoVal / 100, time);
  prevEchoFeedbackNode.gain.setValueAtTime((prevEchoVal / 100) * 0.7, time);
  prevEchoDelayNode.delayTime.setValueAtTime(prevEchoTimeVal / 1000, time);
  
  prevPanNode.pan.setValueAtTime(prevPanVal / 100, time);
  prevReverbWetNode.gain.setValueAtTime((prevReverbVal / 100) * 0.8, time);
  prevGainNode.gain.setValueAtTime(prevVolVal / 100, time);
}

async function loadPreviewSong(dirPath, folderName) {
  try {
    previewSongPath = dirPath;
    const previewPanel = document.getElementById('preview-panel');
    
    // Check if path is a file
    let isFile = false;
    let actualDirPath = dirPath;
    try {
      const stats = fs.statSync(dirPath);
      isFile = stats.isFile();
    } catch (err) {}

    let mainFile = '';
    let vocalsFile = '';
    const instFiles = [];
    let songTitle = folderName;

    if (isFile) {
      actualDirPath = path.dirname(dirPath);
      mainFile = path.basename(dirPath);
      songTitle = path.basename(dirPath, path.extname(dirPath));
    }

    if (previewPanel) {
      previewPanel.classList.add('show');
      document.getElementById('prev-panel-song-title').textContent = songTitle.toUpperCase();
    }
    
    document.getElementById('prev-track-name').textContent = songTitle.toUpperCase();
    
    stopPreviewTrack();
    
    // Clean up dynamic instruments
    previewStems.inst.audios.forEach(item => {
      item.audio.pause();
      item.audio.src = '';
      item.audio.remove();
      if (item.source) item.source.disconnect();
    });
    previewStems.inst.audios = [];
    previewStems.inst.exists = false;
    
    if (!isFile) {
      const files = fs.readdirSync(dirPath);
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
      
      files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (audioExtensions.includes(ext)) {
          const nameLc = path.basename(file, ext).toLowerCase();
          if (nameLc === 'main') mainFile = file;
          else if (nameLc === 'vocals') vocalsFile = file;
          else instFiles.push(file);
        }
      });
      
      // If we don't have main/vocals and only have exactly 1 audio file, treat it as main
      if (!mainFile && !vocalsFile && instFiles.length === 1) {
        mainFile = instFiles.pop();
      }
    }

    const originalAudioPaths = [];
    if (mainFile) originalAudioPaths.push(path.join(actualDirPath, mainFile));
    if (vocalsFile) originalAudioPaths.push(path.join(actualDirPath, vocalsFile));
    instFiles.forEach(file => originalAudioPaths.push(path.join(actualDirPath, file)));
    if (originalAudioPaths.some(isM4aFile)) {
      logConsole('M4A: Checking preview codec compatibility...', 'system');
    }
    const compatibleAudioPaths = await getCompatibleAudioPaths(originalAudioPaths);
    if (previewSongPath !== dirPath) return;
    if (originalAudioPaths.some(originalPath => compatibleAudioPaths.get(originalPath) !== originalPath)) {
      logConsole('M4A: Lossless preview cache ready.', 'system');
    }
    const getPlayablePath = originalPath => (
      compatibleAudioPaths.get(originalPath) || originalPath
    );
    
    initPreviewAudio();
    
    // Load main stem
    const mainIndicator = document.getElementById('prev-ind-main');
    if (mainFile) {
      const originalFilePath = path.join(actualDirPath, mainFile);
      const filePath = getPlayablePath(originalFilePath);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      previewStems.main.audio.src = URL.createObjectURL(blob);
      previewStems.main.audio.preservesPitch = false;
      previewStems.main.audio.playbackRate = prevSpeedVal;
      previewStems.main.audio.load();
      previewStems.main.exists = true;
      
      if (!previewStems.main.source) {
        previewStems.main.source = previewAudioCtx.createMediaElementSource(previewStems.main.audio);
        previewStems.main.source.connect(previewStems.main.gainNode);
      }
      if (mainIndicator) mainIndicator.classList.add('present');
    } else {
      previewStems.main.audio.src = '';
      previewStems.main.exists = false;
      if (mainIndicator) mainIndicator.classList.remove('present');
    }
    
    // Load vocals stem
    const vocalsIndicator = document.getElementById('prev-ind-vocals');
    if (vocalsFile) {
      const originalFilePath = path.join(actualDirPath, vocalsFile);
      const filePath = getPlayablePath(originalFilePath);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      previewStems.vocals.audio.src = URL.createObjectURL(blob);
      previewStems.vocals.audio.preservesPitch = false;
      previewStems.vocals.audio.playbackRate = prevSpeedVal;
      previewStems.vocals.audio.load();
      previewStems.vocals.exists = true;
      
      if (!previewStems.vocals.source) {
        previewStems.vocals.source = previewAudioCtx.createMediaElementSource(previewStems.vocals.audio);
        previewStems.vocals.source.connect(previewStems.vocals.gainNode);
      }
      if (vocalsIndicator) vocalsIndicator.classList.add('present');
    } else {
      previewStems.vocals.audio.src = '';
      previewStems.vocals.exists = false;
      if (vocalsIndicator) vocalsIndicator.classList.remove('present');
    }
    
    // Load instrumental stems
    const instIndicator = document.getElementById('prev-ind-inst');
    if (instFiles.length > 0) {
      instFiles.forEach(file => {
        const originalFilePath = path.join(actualDirPath, file);
        const filePath = getPlayablePath(originalFilePath);
        const data = fs.readFileSync(filePath);
        const mimeType = getMimeType(filePath);
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const audio = new Audio();
        audio.src = url;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.preservesPitch = false;
        audio.playbackRate = prevSpeedVal;
        audio.load();
        
        const source = previewAudioCtx.createMediaElementSource(audio);
        source.connect(previewStems.inst.gainNode);
        
        audio.addEventListener('timeupdate', () => {
          let firstAudio = null;
          if (previewStems.main.exists) firstAudio = previewStems.main.audio;
          else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
          else if (previewStems.inst.audios.length > 0) firstAudio = previewStems.inst.audios[0].audio;
          
          if (firstAudio === audio) {
            updatePreviewProgress();
          }
        });
        
        audio.addEventListener('durationchange', () => {
          let firstAudio = null;
          if (previewStems.main.exists) firstAudio = previewStems.main.audio;
          else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
          else if (previewStems.inst.audios.length > 0) firstAudio = previewStems.inst.audios[0].audio;
          
          if (firstAudio === audio) {
            document.getElementById('prev-time-duration').textContent = formatTime(audio.duration);
          }
        });
        
        audio.addEventListener('ended', () => {
          let firstAudio = null;
          if (previewStems.main.exists) firstAudio = previewStems.main.audio;
          else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
          else if (previewStems.inst.audios.length > 0) firstAudio = previewStems.inst.audios[0].audio;
          
          if (firstAudio === audio) {
            stopPreviewTrack();
          }
        });
        
        previewStems.inst.audios.push({ audio, source, file });
      });
      
      previewStems.inst.exists = true;
      if (instIndicator) instIndicator.classList.add('present');
    } else {
      previewStems.inst.exists = false;
      if (instIndicator) instIndicator.classList.remove('present');
    }
    
    // Wire up listeners for main & vocals elements
    [previewStems.main.audio, previewStems.vocals.audio].forEach(audio => {
      audio.addEventListener('timeupdate', () => {
        let firstAudio = null;
        if (previewStems.main.exists) firstAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
        
        if (firstAudio === audio) {
          updatePreviewProgress();
        }
      });
      
      audio.addEventListener('durationchange', () => {
        let firstAudio = null;
        if (previewStems.main.exists) firstAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
        
        if (firstAudio === audio) {
          document.getElementById('prev-time-duration').textContent = formatTime(audio.duration);
        }
      });
      
      audio.addEventListener('ended', () => {
        let firstAudio = null;
        if (previewStems.main.exists) firstAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
        
        if (firstAudio === audio) {
          stopPreviewTrack();
        }
      });
    });
    
    const previewPaths = [];
    if (mainFile) previewPaths.push(mainFile);
    if (vocalsFile) previewPaths.push(vocalsFile);
    instFiles.forEach(f => previewPaths.push(f));
    generatePreviewStaticWaveform(actualDirPath, previewPaths);
    
    setTimeout(() => {
      playPreviewTrack();
    }, 300);
    
  } catch (err) {
    console.error("Error loading preview song:", err);
  }
}

function generatePreviewStaticWaveform(dirPath, files) {
  previewStaticWaveform = null;
  const pathsToDecode = [];
  files.forEach(file => pathsToDecode.push(path.join(dirPath, file)));
  
  if (pathsToDecode.length === 0) return;
  
  initPreviewAudio();
  const decodePromises = pathsToDecode.map(filePath => (
    decodeAudioFile(previewAudioCtx, filePath).catch(err => {
      console.warn(`Warning Preview Waveform: Unable to decode ${path.basename(filePath)}: ${err.message}`);
      return null;
    })
  ));

  Promise.all(decodePromises).then(buffers => {
    // Associate decoded buffers with preview stems for real-time scratching
    let bufIdx = 0;
    files.forEach(file => {
      if (buffers[bufIdx]) {
        const rev = reverseAudioBuffer(buffers[bufIdx], previewAudioCtx);
        if (previewStems.main.exists && path.basename(previewStems.main.file || '') === path.basename(file)) {
          previewStems.main.buffer = buffers[bufIdx];
          previewStems.main.reversedBuffer = rev;
        } else if (previewStems.vocals.exists && path.basename(previewStems.vocals.file || '') === path.basename(file)) {
          previewStems.vocals.buffer = buffers[bufIdx];
          previewStems.vocals.reversedBuffer = rev;
        } else {
          const instAudio = previewStems.inst.audios.find(item => path.basename(item.file || '') === path.basename(file));
          if (instAudio) {
            instAudio.buffer = buffers[bufIdx];
            instAudio.reversedBuffer = rev;
          }
        }
      }
      bufIdx++;
    });

    const audioBuffers = buffers.filter(buf => buf !== null);
    if (audioBuffers.length === 0) return;

    // Auto-analyze BPM for Preview (Rekordbox-style)
    try {
      const detectedBpm = estimateBPM(audioBuffers[0]);
      console.log(`BPM Preview: Detected ${detectedBpm} BPM`);
      prevBpmVal = detectedBpm;
      const detectedOffset = estimateBeatOffset(audioBuffers[0], detectedBpm);
      prevBeatOffset = detectedOffset;
      const bpmInput = document.getElementById('prev-bpm');
      if (bpmInput) bpmInput.value = detectedBpm;
    } catch (bpmErr) {
      console.error("Preview BPM analysis error:", bpmErr);
    }

    const numPeaks = 2000;
    const maxDuration = Math.max(...audioBuffers.map(buf => buf.duration));
    const peaks = new Float32Array(numPeaks);

    audioBuffers.forEach(buf => {
      const rawData = buf.getChannelData(0);
      const L = rawData.length;
      const SR = buf.sampleRate;
      const duration = buf.duration;

      for (let i = 0; i < numPeaks; i++) {
        const startTime = (i / numPeaks) * maxDuration;
        const endTime = ((i + 1) / numPeaks) * maxDuration;

        if (startTime < duration) {
          const startIdx = Math.floor(startTime * SR);
          const endIdx = Math.min(L, Math.floor(endTime * SR));
          if (endIdx > startIdx) {
            let sum = 0;
            for (let j = startIdx; j < endIdx; j++) {
              sum += Math.abs(rawData[j]);
            }
            peaks[i] += sum / (endIdx - startIdx);
          }
        }
      }
    });

    const maxVal = Math.max(...peaks);
    previewStaticWaveform = Array.from(peaks).map(p => p / (maxVal || 1));
  }).catch(err => {
    console.error("Preview Waveform decode failed:", err);
  });
}

function setPreviewMediaTime(time) {
  const safeTime = Math.max(0, Number(time) || 0);
  if (previewStems.main.exists) previewStems.main.audio.currentTime = safeTime;
  if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = safeTime;
  previewStems.inst.audios.forEach(item => {
    item.audio.currentTime = safeTime;
  });
}

function hasValidPreviewLoopRange() {
  return Number.isFinite(prevLoopStartTime)
    && Number.isFinite(prevLoopEndTime)
    && prevLoopEndTime > prevLoopStartTime;
}

function updatePreviewLoopActivationUi(active, keepRange = false) {
  const autoButton = document.getElementById('prev-btn-auto-loop');
  const inButton = document.getElementById('prev-btn-loop-in');
  const outButton = document.getElementById('prev-btn-loop-out');
  if (autoButton) {
    autoButton.classList.toggle('active', active);
    autoButton.textContent = active ? 'AUTO LOOP ON' : 'AUTO LOOP OFF';
  }
  if (inButton) {
    inButton.classList.toggle('active', active || (keepRange && Number.isFinite(prevLoopStartTime)));
  }
  if (outButton) {
    outButton.classList.toggle('active', active || (keepRange && Number.isFinite(prevLoopEndTime)));
  }
}

function completePreviewOneShotLoop() {
  if (!prevLoopEnabled || prevLoopRepeatEnabled) return;
  prevLoopEnabled = false;
  updatePreviewLoopActivationUi(false, true);
  if (prevLoopExitAction === 'stop') {
    stopPreviewTrack();
    setPreviewMediaTime(0);
    updatePreviewProgress();
  }
}

function restartPreviewLoop() {
  if (!hasValidPreviewLoopRange()) return;
  setPreviewMediaTime(prevLoopStartTime);
  prevLoopEnabled = true;
  updatePreviewLoopActivationUi(true);
  updatePreviewProgress();
}

function updatePreviewProgress() {
  let refAudio = null;
  if (previewStems.main.exists) refAudio = previewStems.main.audio;
  else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
  else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
  
  if (!refAudio || isNaN(refAudio.currentTime)) return;
  
  const ptcEl = document.getElementById('prev-time-current');
  if (ptcEl && document.activeElement !== ptcEl) ptcEl.textContent = formatTime(refAudio.currentTime);
  
  const fill = document.getElementById('prev-progress-fill');
  if (fill) {
    const pct = (refAudio.currentTime / (refAudio.duration || 1)) * 100;
    fill.style.width = `${pct}%`;
  }
}

function playPreviewTrack() {
  if (!previewAudioCtx) initPreviewAudio();
  if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
  
  let refAudio = null;
  if (previewStems.main.exists) refAudio = previewStems.main.audio;
  if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
  if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
  
  if (!refAudio) return;
  
  const startPos = refAudio.currentTime;
  
  if (previewStems.main.exists) {
    previewStems.main.audio.currentTime = startPos;
    previewStems.main.audio.play().catch(e => console.warn(e));
  }
  if (previewStems.vocals.exists) {
    previewStems.vocals.audio.currentTime = startPos;
    previewStems.vocals.audio.play().catch(e => console.warn(e));
  }
  previewStems.inst.audios.forEach(item => {
    item.audio.currentTime = startPos;
    item.audio.play().catch(e => console.warn(e));
  });
  
  previewIsPlaying = true;
  const playBtn = document.getElementById('prev-btn-play');
  if (playBtn) playBtn.classList.add('playing');
  
  if (prevMetronomeOn) {
    startPreviewMetronome();
  }
}

function stopPreviewTrack() {
  if (previewStems.main.exists) previewStems.main.audio.pause();
  if (previewStems.vocals.exists) previewStems.vocals.audio.pause();
  previewStems.inst.audios.forEach(item => item.audio.pause());
  
  previewIsPlaying = false;
  const playBtn = document.getElementById('prev-btn-play');
  if (playBtn) playBtn.classList.remove('playing');
  
  stopPreviewMetronome();
}

function startPreviewMetronome() {
  stopPreviewMetronome();
  if (!prevMetronomeOn) return;
  initPreviewAudio();
  if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
  
  let nextNoteTime = previewAudioCtx.currentTime;
  let beatCount = 0;
  
  prevMetronomeIntervalId = setInterval(() => {
    const scheduleAheadTime = 0.1;
    let beatDuration = 60 / prevBpmVal;
    if (prevBpmDivVal === '1/2') beatDuration /= 2;
    else if (prevBpmDivVal === '1/4') beatDuration /= 4;
    beatDuration /= prevSpeedVal;
    
    while (nextNoteTime < previewAudioCtx.currentTime + scheduleAheadTime) {
      const isDownbeat = (beatCount % 4 === 0);
      if (previewIsPlaying) {
        try {
          const osc = previewAudioCtx.createOscillator();
          const gain = previewAudioCtx.createGain();
          osc.connect(gain).connect(previewAudioCtx.destination);
          
          osc.frequency.setValueAtTime(isDownbeat ? 1200 : 800, nextNoteTime);
          gain.gain.setValueAtTime(0.2, nextNoteTime);
          gain.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + 0.04);
          
          osc.start(nextNoteTime);
          osc.stop(nextNoteTime + 0.05);
        } catch(e) {}
      }
      nextNoteTime += beatDuration;
      beatCount++;
    }
  }, 40);
}

function stopPreviewMetronome() {
  if (prevMetronomeIntervalId) {
    clearInterval(prevMetronomeIntervalId);
    prevMetronomeIntervalId = null;
  }
}

function updatePrevKnobUI(param, val, { syncInput = true } = {}) {
  const knobFill = document.getElementById(`knob-prev-${param}-fill`);
  const knobPointer = document.getElementById(`knob-prev-${param}-pointer`);
  const valDisplay = document.getElementById(`val-prev-${param}`);
  
  if (!knobFill || !knobPointer) return;

  const input = document.getElementById(`prev-${param}`);
  if (input && syncInput) {
    input.value = val;
  }

  let percent = 0;
  let formatted = '';

  if (param === 'bass' || param === 'low' || param === 'treb' || param === 'pitch') {
    percent = (val - (-12)) / (12 - (-12));
    if (param === 'pitch') {
      const displayPitch = Math.abs(val) < 0.05 ? 0 : val;
      formatted = `${displayPitch > 0 ? '+' : ''}${displayPitch.toFixed(1)} st`;
    } else {
      formatted = `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;
    }
  } else if (param === 'speed') {
    percent = (val - 50) / (200 - 50);
    formatted = `${Math.round(val)}%`;
  } else if (param === 'filter') {
    percent = val / 100;
    if (val === 50) {
      formatted = 'Byp';
    } else if (val < 50) {
      formatted = `LP ${Math.round((50 - val) * 2)}%`;
    } else {
      formatted = `HP ${Math.round((val - 50) * 2)}%`;
    }
  } else if (param === 'pan') {
    percent = (val - (-100)) / (100 - (-100));
    if (val === 0) {
      formatted = 'C';
    } else if (val < 0) {
      formatted = `L ${Math.abs(val)}`;
    } else {
      formatted = `R ${val}`;
    }
  } else if (param === 'echotime') {
    percent = (val - 100) / (1000 - 100);
    formatted = `${Math.round(val)} ms`;
  } else {
    percent = val / 100;
    formatted = `${Math.round(val)}%`;
  }

  percent = Math.max(0, Math.min(1, percent));
  drawKnobArc(knobFill, percent);
  const angle = -135 + (percent * 270);
  knobPointer.setAttribute('transform', `rotate(${angle} 20 20)`);
  if (valDisplay) {
    valDisplay.textContent = formatted;
  }
}

function updatePreviewPitchUI() {
  const input = document.getElementById('prev-pitch');
  if (input) input.value = prevPitchVal;

  const effectivePitch = prevPitchVal + getVinylPitchSemitones(prevSpeedVal);
  updatePrevKnobUI('pitch', effectivePitch, { syncInput: false });
}

function setupPrevKnobDrag(param) {
  const wrapper = document.getElementById(`knob-prev-${param}-wrapper`);
  const slider = document.getElementById(`prev-${param}`);
  if (!wrapper || !slider) return;

  let isDragging = false;
  let startY = 0;
  let startValue = 0;
  let snapTarget = null;
  if (['bass', 'low', 'treb', 'pitch', 'pan'].includes(param)) {
    snapTarget = 0;
  } else if (param === 'filter') {
    snapTarget = 50;
  } else if (param === 'speed') {
    snapTarget = 100;
  }

  wrapper.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startValue = parseFloat(slider.value);
    
    const onMouseMove = (moveEv) => {
      if (!isDragging) return;
      const deltaY = startY - moveEv.clientY;
      const rangePixels = 100;
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      const range = max - min;
      
      let newVal = startValue + (deltaY / rangePixels) * range;
      newVal = Math.max(min, Math.min(max, newVal));
      
      if (snapEnabled && snapTarget !== null) {
        const thresholdVal = (snapThresholdPct / 100) * range;
        if (Math.abs(newVal - snapTarget) <= thresholdVal) {
          newVal = snapTarget;
        }
      }
      
      slider.value = newVal;
      slider.dispatchEvent(new Event('input'));
    };
    
    const onMouseUp = () => {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });
}

function drawPrevVisualizer() {
  const canvas = document.getElementById('prev-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resizeCanvas();
  
  function draw() {
    requestAnimationFrame(draw);
    
    try {
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      }
      
      // Hide or show the preview overview canvas
      const overviewCanvas = document.getElementById('prev-overview-canvas');
      if (overviewCanvas) {
        overviewCanvas.style.display = (previewVisMode === 'waveform') ? 'block' : 'none';
      }
      
      const trackColor = '#ff5500'; // Orange theme for preview inside app
    
    // Draw Preview Overview Waveform if available and visible
    if (overviewCanvas && previewVisMode === 'waveform' && previewStaticWaveform && previewStaticWaveform.length > 0) {
      const oCtx = overviewCanvas.getContext('2d');
      const oW = overviewCanvas.width = overviewCanvas.clientWidth;
      const oH = overviewCanvas.height = overviewCanvas.clientHeight;
      
      oCtx.fillStyle = '#0d0d0d';
      oCtx.fillRect(0, 0, oW, oH);
      
      // Draw continuous Audacity-style waveform for overview (unplayed grey base with gradient)
      const unplayedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
      unplayedGrad.addColorStop(0, '#2a2a2a');
      unplayedGrad.addColorStop(0.5, '#5c5c5c');
      unplayedGrad.addColorStop(1, '#2a2a2a');
      oCtx.fillStyle = unplayedGrad;
      
      oCtx.beginPath();
      let first = true;
      const step = oW / previewStaticWaveform.length;
      for (let i = 0; i < previewStaticWaveform.length; i++) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH - h) / 2;
        const x = i * step;
        if (first) {
          oCtx.moveTo(x, y);
          first = false;
        } else {
          oCtx.lineTo(x, y);
        }
      }
      for (let i = previewStaticWaveform.length - 1; i >= 0; i--) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH + h) / 2;
        const x = i * step;
        oCtx.lineTo(x, y);
      }
      oCtx.closePath();
      oCtx.fill();
      
      // Fill the played portion in gradient color
      let currentPct = 0;
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      if (refAudio) {
        currentPct = refAudio.currentTime / (refAudio.duration || 1);
      }
      const playedX = currentPct * oW;
      
      oCtx.save();
      oCtx.beginPath();
      oCtx.rect(0, 0, playedX, oH);
      oCtx.clip();
      
      const playedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
      playedGrad.addColorStop(0, '#cc4400');
      playedGrad.addColorStop(0.5, '#ffccb3');
      playedGrad.addColorStop(1, '#cc4400');
      oCtx.fillStyle = playedGrad;
      
      oCtx.beginPath();
      first = true;
      for (let i = 0; i < previewStaticWaveform.length; i++) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH - h) / 2;
        const x = i * step;
        if (first) {
          oCtx.moveTo(x, y);
          first = false;
        } else {
          oCtx.lineTo(x, y);
        }
      }
      for (let i = previewStaticWaveform.length - 1; i >= 0; i--) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH + h) / 2;
        const x = i * step;
        oCtx.lineTo(x, y);
      }
      oCtx.closePath();
      oCtx.fill();
      oCtx.restore();
      
      // Draw moving vertical playhead indicator (red line)
      oCtx.strokeStyle = '#ff003c';
      oCtx.lineWidth = 1.5;
      oCtx.beginPath();
      oCtx.moveTo(playedX, 0);
      oCtx.lineTo(playedX, oH);
      oCtx.stroke();

      // Highlight preview loop region on overview
      if (hasValidPreviewLoopRange()) {
        const duration = (refAudio && refAudio.duration) ? refAudio.duration : 180;
        const loopStartX = (prevLoopStartTime / duration) * oW;
        const loopEndX = (prevLoopEndTime / duration) * oW;
        
        oCtx.fillStyle = prevLoopEnabled
          ? 'rgba(0, 255, 204, 0.25)'
          : 'rgba(145, 145, 145, 0.18)';
        oCtx.fillRect(loopStartX, 0, loopEndX - loopStartX, oH);
        oCtx.strokeStyle = prevLoopEnabled ? '#00ffcc' : '#777777';
        oCtx.lineWidth = 1;
        oCtx.beginPath();
        oCtx.moveTo(loopStartX, 0); oCtx.lineTo(loopStartX, oH);
        oCtx.moveTo(loopEndX, 0); oCtx.lineTo(loopEndX, oH);
        oCtx.stroke();
      }
    }
    
    // Loop Check for Preview
    if (prevLoopEnabled && prevLoopStartTime !== null && prevLoopEndTime !== null) {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (refAudio && refAudio.currentTime >= prevLoopEndTime) {
        if (prevLoopRepeatEnabled) {
          const overshoot = refAudio.currentTime - prevLoopEndTime;
          const targetTime = prevLoopStartTime + (overshoot % (prevLoopEndTime - prevLoopStartTime));
          setPreviewMediaTime(targetTime);
        } else if (previewIsPlaying) {
          completePreviewOneShotLoop();
        } else {
          setPreviewMediaTime(prevLoopStartTime);
        }
      }
    }
    
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, width, height);
    
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    const mode = previewVisMode;
    let refAnalyser = null;
    if (prevAnalyser && previewIsPlaying) {
      refAnalyser = prevAnalyser;
    }
    
    if (mode === 'osc') {
      if (refAnalyser) {
        const bufferLength = refAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        refAnalyser.getByteTimeDomainData(dataArray);
        
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = trackColor;
        ctx.beginPath();
        
        const sliceWidth = width / bufferLength;
        let x = 0;
        
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = (v * height) / 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }
    } else if (mode === 'spectrum') {
      if (refAnalyser) {
        const bufferLength = refAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        refAnalyser.getByteFrequencyData(dataArray);
        
        const numBars = 40;
        const barWidth = width / numBars;
        
        for (let i = 0; i < numBars; i++) {
          const dataIndex = Math.floor((i / numBars) * (bufferLength * 0.6));
          const val = dataArray[dataIndex] || 0;
          const barHeight = (val / 255) * height * 0.85;
          ctx.fillStyle = trackColor;
          ctx.fillRect(i * barWidth, height - barHeight, barWidth - 1.5, barHeight);
        }
      } else {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }
    } else if (mode === 'waveform') {
      if (previewStaticWaveform && previewStaticWaveform.length > 0) {
        let currentPct = 0;
        let refAudio = null;
        if (previewStems.main.exists) refAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
        else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
        
        if (refAudio) {
          currentPct = refAudio.currentTime / (refAudio.duration || 1);
        } else {
          const fill = document.getElementById('prev-progress-fill');
          if (fill && fill.style.width) {
            currentPct = parseFloat(fill.style.width) / 100;
          }
        }
        
        // Draw grid/background
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(0, 0, width, height);
        
        // Draw grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 40) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        
        const duration = (refAudio && refAudio.duration) ? refAudio.duration : 180;
        const visibleSeconds = 30; // Zoomed out as requested
        const zoomPercent = (visibleSeconds / 2) / duration;
        
        // Draw smooth Audacity-style waveform for preview (Top/Bottom curves filled with gradient)
        function drawContinuousWaveform(startPixel, endPixel, colorType) {
          const grad = ctx.createLinearGradient(0, height * 0.075, 0, height * 0.925);
          if (colorType === 'played') {
            grad.addColorStop(0, '#cc4400');
            grad.addColorStop(0.5, '#ffccb3');
            grad.addColorStop(1, '#cc4400');
          } else {
            grad.addColorStop(0, '#2e2e2e');
            grad.addColorStop(0.5, '#5c5c5c');
            grad.addColorStop(1, '#2e2e2e');
          }

          ctx.fillStyle = grad;
          ctx.beginPath();
          
          let first = true;
          // Top half
          for (let pixelX = startPixel; pixelX <= endPixel; pixelX += 2) {
            const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
            if (pct >= 0 && pct <= 1) {
              const waveformIndex = Math.floor(pct * previewStaticWaveform.length);
              const peak = previewStaticWaveform[waveformIndex] || 0;
              const h = Math.max(1, peak * height * 0.85);
              const y = (height - h) / 2;
              if (first) {
                ctx.moveTo(pixelX, y);
                first = false;
              } else {
                ctx.lineTo(pixelX, y);
              }
            }
          }
          
          // Bottom half
          for (let pixelX = endPixel; pixelX >= startPixel; pixelX -= 2) {
            const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
            if (pct >= 0 && pct <= 1) {
              const waveformIndex = Math.floor(pct * previewStaticWaveform.length);
              const peak = previewStaticWaveform[waveformIndex] || 0;
              const h = Math.max(1, peak * height * 0.85);
              const y = (height + h) / 2;
              ctx.lineTo(pixelX, y);
            }
          }
          
          ctx.closePath();
          ctx.fill();
        }
        
        // Draw played section (left of center playhead)
        drawContinuousWaveform(0, width / 2, 'played');
        
        // Draw unplayed section (right of center playhead)
        drawContinuousWaveform(width / 2, width, 'unplayed');
        
        // Draw horizontal center line on top of the scrolling waveform (Audacity style)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Draw Rekordbox-style beat grid lines for Preview
        const beatDuration = 60 / prevBpmVal;
        const offset = prevBeatOffset || 0;
        const leftTime = (currentPct - zoomPercent) * duration;
        const rightTime = (currentPct + zoomPercent) * duration;
        
        const firstVisibleBeat = Math.ceil((leftTime - offset) / beatDuration);
        const lastVisibleBeat = Math.floor((rightTime - offset) / beatDuration);
        
        for (let n = Math.max(0, firstVisibleBeat); n <= lastVisibleBeat; n++) {
          const beatTime = offset + n * beatDuration;
          const beatPct = beatTime / duration;
          const beatX = width / 2 + ((beatPct - currentPct) / zoomPercent) * (width / 2);
          
          if (n % 4 === 0) {
            // Downbeat (Red/orange line with bar number)
            ctx.strokeStyle = 'rgba(255, 0, 60, 0.45)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(beatX, 0);
            ctx.lineTo(beatX, height);
            ctx.stroke();
            
            ctx.fillStyle = 'rgba(255, 0, 60, 0.7)';
            ctx.font = '8px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(Math.floor(n / 4) + 1, beatX + 3, 10);
          } else {
            // Offbeat (White/grey line)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(beatX, 0);
            ctx.lineTo(beatX, height);
            ctx.stroke();
            
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.font = '8px monospace';
            ctx.textAlign = 'left';
            ctx.fillText((n % 4) + 1, beatX + 3, height - 4);
          }
        }

        // Center playhead (Red line with Rekordbox triangles)
        ctx.strokeStyle = '#ff003c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width / 2, height);
        ctx.stroke();
        
        // Top playhead triangle marker
        ctx.fillStyle = '#ff003c';
        ctx.beginPath();
        ctx.moveTo(width / 2 - 5, 0);
        ctx.lineTo(width / 2 + 5, 0);
        ctx.lineTo(width / 2, 6);
        ctx.closePath();
        ctx.fill();
        
        // Bottom playhead triangle marker
        ctx.beginPath();
        ctx.moveTo(width / 2 - 5, height);
        ctx.lineTo(width / 2 + 5, height);
        ctx.lineTo(width / 2, height - 6);
        ctx.closePath();
        ctx.fill();
        
        // Highlight preview loop boundaries on scrolling waveform
        if (hasValidPreviewLoopRange()) {
          const startPct = prevLoopStartTime / duration;
          const endPct = prevLoopEndTime / duration;
          
          const startX = width / 2 + ((startPct - currentPct) / zoomPercent) * (width / 2);
          const endX = width / 2 + ((endPct - currentPct) / zoomPercent) * (width / 2);
          
          ctx.fillStyle = prevLoopEnabled
            ? 'rgba(0, 255, 204, 0.15)'
            : 'rgba(145, 145, 145, 0.12)';
          ctx.fillRect(startX, 0, endX - startX, height);
          
          ctx.strokeStyle = prevLoopEnabled ? '#00ffcc' : '#777777';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
          ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = '#666';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText("NO AUDIO FILE LOADED", width / 2, height / 2 + 3);
      }
    }
  } catch (err) {
    console.error("Preview visualizer draw error:", err);
  }
}
  draw();
  window.addEventListener('resize', resizeCanvas);
  
  const previewPanel = document.getElementById('preview-panel');
  if (previewPanel && typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    resizeObserver.observe(previewPanel);
  }
}

function initInAppPreview() {
  const previewPanel = document.getElementById('preview-panel');
  if (!previewPanel) return;

  const header = previewPanel.querySelector('.in-app-window-header');
  makeElementDraggable(previewPanel, header);
  makeElementResizable(previewPanel);

  const closeBtn = document.getElementById('preview-panel-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      previewPanel.classList.remove('show');
      stopPreviewTrack();
    });
  }

  const playBtn = document.getElementById('prev-btn-play');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (previewIsPlaying) stopPreviewTrack();
      else playPreviewTrack();
    });
  }

  const stopBtn = document.getElementById('prev-btn-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      stopPreviewTrack();
      [previewStems.main.audio, previewStems.vocals.audio].forEach(audio => {
        if (audio) audio.currentTime = 0;
      });
      previewStems.inst.audios.forEach(item => {
        if (item.audio) item.audio.currentTime = 0;
      });
      updatePreviewProgress();
    });
  }

  ['spectrum', 'waveform'].forEach(mode => {
    const btn = document.getElementById(`prev-btn-vis-${mode}`);
    if (btn) {
      btn.addEventListener('click', () => {
        if (mode === 'spectrum' && !notoMixerConfig.enableSpectrum) return;
        document.querySelectorAll('#prev-visualizer-block .visualizer-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        previewVisMode = mode;
      });
    }
  });

  const tabs = document.querySelectorAll('#track-prev .track-tab-btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabName = btn.getAttribute('data-tab');
      document.querySelectorAll('#track-prev .track-tab-content').forEach(c => c.classList.remove('active'));
      if (tabName === 'eq') {
        document.getElementById('prev-track-content-eq').classList.add('active');
      } else {
        document.getElementById('prev-track-content-buttons').classList.add('active');
      }
    });
  });

  // Hook up canvas scratching for Preview
  const prevCanvas = document.getElementById('prev-canvas');
  if (prevCanvas) {
    setupPreviewCanvasScratching(prevCanvas);
  }

  const prevOverviewCanvas = document.getElementById('prev-overview-canvas');
  if (prevOverviewCanvas) {
    prevOverviewCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || isNaN(refAudio.duration)) return;
      
      const scrub = (moveEvent) => {
        const rect = prevOverviewCanvas.getBoundingClientRect();
        const clickX = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
        const pct = clickX / rect.width;
        const newTime = pct * refAudio.duration;
        
        if (previewStems.main.exists) previewStems.main.audio.currentTime = newTime;
        if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = newTime;
        previewStems.inst.audios.forEach(item => item.audio.currentTime = newTime);
        updatePreviewProgress();
      };
      
      scrub(e);
      
      const onMove = (moveEvent) => scrub(moveEvent);
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // Editable Time Current (Preview)
  const prevTimeCurrentEl = document.getElementById('prev-time-current');
  if (prevTimeCurrentEl) {
    const applyPrevTimeEdit = () => {
      const text = prevTimeCurrentEl.textContent.trim();
      let newTime = 0;
      if (text.includes(':')) {
        const parts = text.split(':');
        if (parts.length === 2) {
          newTime = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
        } else if (parts.length === 3) {
          newTime = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
        }
      } else {
        newTime = parseFloat(text);
      }
      
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!isNaN(newTime) && newTime >= 0 && refAudio) {
        newTime = Math.min(newTime, refAudio.duration || newTime);
        
        if (previewStems.main.exists) previewStems.main.audio.currentTime = newTime;
        if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = newTime;
        previewStems.inst.audios.forEach(item => item.audio.currentTime = newTime);
        updatePreviewProgress();
      } else {
        if (refAudio) {
          prevTimeCurrentEl.textContent = formatTime(refAudio.currentTime);
        }
      }
      prevTimeCurrentEl.blur();
    };
    
    prevTimeCurrentEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyPrevTimeEdit();
      }
    });
    prevTimeCurrentEl.addEventListener('blur', applyPrevTimeEdit);
    prevTimeCurrentEl.addEventListener('focus', () => {
      setTimeout(() => document.execCommand('selectAll', false, null), 50);
    });
  }

  // Preview Loop control UI bindings
  const btnAutoLoop = document.getElementById('prev-btn-auto-loop');
  const btnHalve = document.getElementById('prev-btn-loop-halve');
  const btnDouble = document.getElementById('prev-btn-loop-double');
  const displayLoop = document.getElementById('prev-loop-display');
  const btnLoopIn = document.getElementById('prev-btn-loop-in');
  const btnLoopOut = document.getElementById('prev-btn-loop-out');
  const btnLoopExit = document.getElementById('prev-btn-loop-exit');
  const btnLoopRepeat = document.getElementById('prev-btn-loop-repeat');
  const btnLoopRestart = document.getElementById('prev-btn-loop-restart');
  
  const loopOptions = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
  let selectedOptionIndex = 6; // default 4 BEATS
  
  function updateLoopDisplay() {
    const beats = loopOptions[selectedOptionIndex];
    prevAutoLoopBeats = beats;
    if (beats < 1) {
      if (beats === 0.0625) displayLoop.textContent = "1/16";
      else if (beats === 0.125) displayLoop.textContent = "1/8";
      else if (beats === 0.25) displayLoop.textContent = "1/4";
      else if (beats === 0.5) displayLoop.textContent = "1/2";
    } else {
      displayLoop.textContent = beats.toString();
    }
  }
  
  if (btnHalve && btnDouble && displayLoop) {
    btnHalve.addEventListener('click', () => {
      if (selectedOptionIndex > 0) {
        selectedOptionIndex--;
        updateLoopDisplay();
        if (prevLoopEnabled) {
          triggerAutoLoop();
        }
      }
    });
    btnDouble.addEventListener('click', () => {
      if (selectedOptionIndex < loopOptions.length - 1) {
        selectedOptionIndex++;
        updateLoopDisplay();
        if (prevLoopEnabled) {
          triggerAutoLoop();
        }
      }
    });
  }
  
  if (btnAutoLoop) {
    btnAutoLoop.addEventListener('click', () => {
      if (prevLoopEnabled) {
        prevLoopEnabled = false;
        prevLoopStartTime = null;
        prevLoopEndTime = null;
        btnAutoLoop.classList.remove('active');
        btnAutoLoop.textContent = "AUTO LOOP OFF";
        if (btnLoopIn) btnLoopIn.classList.remove('active');
        if (btnLoopOut) btnLoopOut.classList.remove('active');
      } else {
        triggerAutoLoop();
      }
    });
  }
  
  function triggerAutoLoop() {
    let refAudio = null;
    if (previewStems.main.exists) refAudio = previewStems.main.audio;
    else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
    else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
    
    if (!refAudio || isNaN(refAudio.duration)) return;
    
    const bpm = prevBpmVal || 120;
    const beatDuration = 60 / bpm;
    const loopDuration = prevAutoLoopBeats * beatDuration;
    
    if (prevLoopStartTime === null) {
      prevLoopStartTime = refAudio.currentTime;
    }
    prevLoopEndTime = prevLoopStartTime + loopDuration;
    
    if (prevLoopEndTime > refAudio.duration) {
      prevLoopEndTime = refAudio.duration;
      prevLoopStartTime = Math.max(0, prevLoopEndTime - loopDuration);
    }
    
    prevLoopEnabled = true;
    if (btnAutoLoop) {
      btnAutoLoop.classList.add('active');
      btnAutoLoop.textContent = `AUTO LOOP ON`;
    }
    if (btnLoopIn) btnLoopIn.classList.add('active');
    if (btnLoopOut) btnLoopOut.classList.add('active');
  }
  
  if (btnLoopIn) {
    btnLoopIn.addEventListener('click', () => {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || isNaN(refAudio.duration)) return;
      
      prevLoopStartTime = refAudio.currentTime;
      btnLoopIn.classList.add('active');
      
      if (prevLoopEndTime !== null && prevLoopEndTime > prevLoopStartTime) {
        prevLoopEnabled = true;
        if (btnLoopOut) btnLoopOut.classList.add('active');
      }
    });
  }
  
  if (btnLoopOut) {
    btnLoopOut.addEventListener('click', () => {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || isNaN(refAudio.duration)) return;
      
      if (prevLoopStartTime === null) {
        prevLoopStartTime = 0;
        if (btnLoopIn) btnLoopIn.classList.add('active');
      }
      
      prevLoopEndTime = refAudio.currentTime;
      if (prevLoopEndTime <= prevLoopStartTime) {
        prevLoopEndTime = prevLoopStartTime + 1;
      }
      
      prevLoopEnabled = true;
      btnLoopOut.classList.add('active');
    });
  }
  
  if (btnLoopExit) {
    btnLoopExit.addEventListener('click', () => {
      prevLoopEnabled = false;
      prevLoopStartTime = null;
      prevLoopEndTime = null;
      if (btnAutoLoop) {
        btnAutoLoop.classList.remove('active');
        btnAutoLoop.textContent = "AUTO LOOP OFF";
      }
      if (btnLoopIn) btnLoopIn.classList.remove('active');
      if (btnLoopOut) btnLoopOut.classList.remove('active');
    });
  }

  if (btnLoopRepeat) {
    btnLoopRepeat.addEventListener('click', () => {
      prevLoopRepeatEnabled = !prevLoopRepeatEnabled;
      btnLoopRepeat.classList.toggle('active', prevLoopRepeatEnabled);
      btnLoopRepeat.setAttribute('aria-pressed', prevLoopRepeatEnabled ? 'true' : 'false');
    });
  }

  if (btnLoopRestart) {
    btnLoopRestart.addEventListener('click', restartPreviewLoop);
  }

  const progHit = document.getElementById('prev-prog-hit');
  const progContainer = document.getElementById('prev-prog-container');
  if (progHit && progContainer) {
    let isScrubbing = false;
    
    function scrub(clientX) {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || !refAudio.duration) return;
      
      const rect = progContainer.getBoundingClientRect();
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      
      const seekTime = pct * refAudio.duration;
      
      if (previewStems.main.exists) previewStems.main.audio.currentTime = seekTime;
      if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = seekTime;
      previewStems.inst.audios.forEach(item => item.audio.currentTime = seekTime);
      
      updatePreviewProgress();
    }
    
    progHit.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      progContainer.classList.add('scrubbing');
      scrub(e.clientX);
    });
    
    window.addEventListener('mousemove', (e) => {
      if (isScrubbing) scrub(e.clientX);
    });
    
    window.addEventListener('mouseup', () => {
      if (isScrubbing) {
        isScrubbing = false;
        progContainer.classList.remove('scrubbing');
      }
    });
  }

  const volInput = document.getElementById('prev-vol');
  if (volInput) {
    volInput.addEventListener('input', () => {
      let val = parseInt(volInput.value) || 0;
      val = Math.max(0, Math.min(100, val));
      prevVolVal = val;
      applyPreviewFilters();
    });
  }

  const bpmInput = document.getElementById('prev-bpm');
  if (bpmInput) {
    bpmInput.addEventListener('input', () => {
      let val = parseInt(bpmInput.value) || 120;
      val = Math.max(20, Math.min(300, val));
      prevBpmVal = val;
      if (prevMetronomeOn) startPreviewMetronome();
    });
  }

  const beatSelect = document.getElementById('prev-bpmdiv');
  if (beatSelect) {
    beatSelect.addEventListener('change', () => {
      prevBpmDivVal = beatSelect.value;
      if (prevMetronomeOn) startPreviewMetronome();
    });
  }

  const metroBtn = document.getElementById('prev-btn-metro');
  if (metroBtn) {
    metroBtn.addEventListener('click', () => {
      prevMetronomeOn = !prevMetronomeOn;
      if (prevMetronomeOn) {
        metroBtn.classList.add('active');
        startPreviewMetronome();
      } else {
        metroBtn.classList.remove('active');
        stopPreviewMetronome();
      }
    });
  }

  const tapBtn = document.getElementById('prev-btn-tap');
  if (tapBtn) {
    tapBtn.addEventListener('click', tapPreviewTempo);
  }

  const params = [
    'bass', 'low', 'treb', 'inst', 'voc',
    'filter', 'pitch', 'speed', 'echo',
    'pan', 'reverb', 'echotime'
  ];
  
  params.forEach(param => {
    const slider = document.getElementById(`prev-${param}`);
    if (slider) {
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        if (param === 'bass') prevBassVal = val;
        else if (param === 'low') prevLowVal = val;
        else if (param === 'treb') prevTrebVal = val;
        else if (param === 'inst') prevInstVal = val;
        else if (param === 'voc') prevVocVal = val;
        else if (param === 'filter') prevFilterVal = val;
        else if (param === 'pitch') prevPitchVal = val;
        else if (param === 'speed') prevSpeedVal = val / 100;
        else if (param === 'echo') prevEchoVal = val;
        else if (param === 'pan') prevPanVal = val;
        else if (param === 'reverb') prevReverbVal = val;
        else if (param === 'echotime') prevEchoTimeVal = val;
        
        updatePrevKnobUI(param, val);
        if (param === 'pitch' || param === 'speed') {
          updatePreviewPitchUI();
        }
        applyPreviewFilters();
      });
      
      updatePrevKnobUI(param, parseFloat(slider.value));
      setupPrevKnobDrag(param);
    }
  });
  updatePreviewPitchUI();

  for (let i = 0; i < 8; i++) {
    const btn = document.getElementById(`prev-sound-btn-${i}`);
    const cell = document.getElementById(`prev-sound-btn-cell-${i}`);
    if (btn && cell) {
      
      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        cell.classList.add('dragover');
      });
      
      cell.addEventListener('dragleave', () => {
        cell.classList.remove('dragover');
      });
      
      cell.addEventListener('drop', async (e) => {
        e.preventDefault();
        cell.classList.remove('dragover');
        
        if (e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          const filePath = getDroppedFilePath(file);
          const fileName = file.name || path.basename(filePath);
          if (!filePath) {
            logConsole('Err: Unable to resolve the dropped preview audio file path', 'err');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
          if (audioExtensions.includes(ext)) {
            try {
              initPreviewAudio();
              const audioBuffer = await decodeAudioFile(previewAudioCtx, filePath);
              stopPreviewSampleEffect(i);
              previewSoundButtons[i].buffer = audioBuffer;
              previewSoundButtons[i].path = filePath;
              previewSoundButtons[i].name = fileName;
              btn.textContent = fileName.toUpperCase();
              btn.classList.remove('empty-sound-btn');
              btn.classList.add('loaded');
              btn.title = `${filePath} — right-click for effect settings; middle-click to stop`;
            } catch (err) {
              logConsole(`Err: Failed to decode preview sample '${fileName}': ${err.message}`, 'err');
            }
          }
        }
      });
      
      btn.addEventListener('click', () => {
        playPreviewSampleEffect(i, btn);
      });

      btn.addEventListener('mousedown', event => {
        if (event.button === 1) event.preventDefault();
      });

      btn.addEventListener('auxclick', event => {
        if (event.button !== 1) return;
        event.preventDefault();
        if (previewSoundButtons[i].buffer) {
          stopPreviewSampleEffect(i, { logStop: true });
        }
      });

      btn.addEventListener('contextmenu', event => {
        if (!previewSoundButtons[i].buffer) return;
        event.preventDefault();
        event.stopPropagation();
        openSampleSettings({ buttonIndex: i, preview: true });
      });
    }
  }

  const percentSymbol = document.getElementById('prev-vol-percent-symbol');
  if (percentSymbol && volInput) {
    percentSymbol.style.cursor = 'ns-resize';
    percentSymbol.style.userSelect = 'none';
    let isDragging = false;
    let startY = 0;
    let startVal = 0;
    percentSymbol.addEventListener('mousedown', (e) => {
      isDragging = true;
      startY = e.clientY;
      startVal = parseInt(volInput.value) || 0;
      
      const onMove = (moveEv) => {
        if (!isDragging) return;
        const delta = startY - moveEv.clientY;
        let newVol = startVal + delta;
        newVol = Math.max(0, Math.min(100, newVol));
        volInput.value = newVol;
        prevVolVal = newVol;
        applyPreviewFilters();
      };
      
      const onUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  drawPrevVisualizer();
}

function setupCanvasScratching(trackNum, canvas) {
  let isDragging = false;
  let startX = 0;
  let startTime = 0;
  let wasPlaying = false;
  let lastX = 0;
  let scratchSources = [];
  let animId = null;
  
  // Scratch loop parameters
  let lastFrameTime = 0;
  let lastPlayheadTime = 0;
  let currentClientX = 0;
  let edgeScrollSpeed = 0;
  let scratchDirection = null; // true = forward, false = backward

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const track = tracks[trackNum];
    if (track.visMode !== 'waveform') return;
    
    let stems = [];
    if (track.stems.main.exists) stems.push({ stem: track.stems.main, gainNode: track.stems.main.gainNode });
    if (track.stems.vocals.exists) stems.push({ stem: track.stems.vocals, gainNode: track.stems.vocals.gainNode });
    track.stems.inst.audios.forEach(item => {
      stems.push({ stem: item, gainNode: track.stems.inst.gainNode });
    });
    
    if (stems.length === 0) return;
    const refAudio = stems[0].stem.audio;
    if (!refAudio || isNaN(refAudio.duration) || refAudio.duration === 0) return;
    
    isDragging = true;
    startX = e.clientX;
    lastX = e.clientX;
    currentClientX = e.clientX;
    startTime = refAudio.currentTime;
    wasPlaying = track.isPlaying;
    
    // Pause HTML5 audios to avoid double playback stutter
    stems.forEach(s => s.stem.audio.pause());
    
    // Initialize frame calculations
    lastFrameTime = performance.now();
    lastPlayheadTime = startTime;
    edgeScrollSpeed = 0;
    scratchDirection = null;
    scratchSources = [];
    
    const width = canvas.width;
    const visibleSeconds = 30;
    const pixelsPerSecond = width / visibleSeconds;
    let audioPlayheadTime = startTime;

    // Start unified physics animation loop
    function scratchLoop() {
      if (!isDragging) return;
      animId = requestAnimationFrame(scratchLoop);
      
      const now = performance.now();
      const deltaTime = (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      
      if (deltaTime <= 0) return;
      
      if (edgeScrollSpeed !== 0) {
        startTime += edgeScrollSpeed * deltaTime;
        startTime = Math.max(0, Math.min(refAudio.duration - 0.02, startTime));
      }
      
      const dx = currentClientX - startX;
      const timeDelta = (dx / pixelsPerSecond) * 1.0;
      let newTime = startTime - timeDelta;
      
      if (newTime < 0) {
        newTime = 0;
        startX = currentClientX - (startTime * pixelsPerSecond / 1.0);
      } else if (newTime > refAudio.duration - 0.02) {
        newTime = refAudio.duration - 0.02;
        startX = currentClientX + ((refAudio.duration - 0.02 - startTime) * pixelsPerSecond / 1.0);
      }
      
      // 1:1 direct tracking (no lag)
      const dtAudio = newTime - audioPlayheadTime;
      const secondsPerSecond = dtAudio / deltaTime;
      
      let targetRate = secondsPerSecond;
      if (Math.abs(targetRate) >= 1.0) {
         targetRate = Math.sign(targetRate) * Math.pow(Math.abs(targetRate), 0.65);
      }
      targetRate = Math.max(-50.0, Math.min(50.0, targetRate));
      
      // Force waveform to stick perfectly to the mouse
      audioPlayheadTime = newTime;
      
      const isForward = (targetRate >= 0);
      const absRate = Math.abs(targetRate);
      
      // Swap buffers on direction change to support true backward scratching in Chromium
      if (scratchDirection === null || scratchDirection !== isForward) {
        scratchSources.forEach(item => {
          try { item.source.stop(); item.source.disconnect(); item.gain.disconnect(); } catch (err) {}
        });
        scratchSources = [];
        scratchDirection = isForward;
        
        if (wasPlaying) {
          stems.forEach(s => {
            const buf = isForward ? s.stem.buffer : s.stem.reversedBuffer;
            if (buf) {
              try {
                const srcNode = audioCtx.createBufferSource();
                srcNode.buffer = buf;
                srcNode.loop = false;
                
                const gainNode = audioCtx.createGain();
                srcNode.connect(gainNode);
                gainNode.connect(s.gainNode);
                
                const startPos = isForward ? audioPlayheadTime : (buf.duration - audioPlayheadTime);
                srcNode.start(0, Math.max(0, startPos));
                srcNode.playbackRate.setValueAtTime(absRate, audioCtx.currentTime);
                
                scratchSources.push({ source: srcNode, gain: gainNode, stem: s.stem });
              } catch (err) {}
            }
          });
        }
      } else {
        // Modulate playbackRate with turntable platter inertia
        scratchSources.forEach(item => {
          item.source.playbackRate.setTargetAtTime(absRate, audioCtx.currentTime, 0.015);
        });
      }
      
      // Sync HTML5 media position silently to audioPlayheadTime
      stems.forEach(s => {
        s.stem.audio.currentTime = audioPlayheadTime;
      });
      
      handleTrackProgress(trackNum, true);
    }
    
    animId = requestAnimationFrame(scratchLoop);
    canvas.classList.add('grabbing');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    currentClientX = e.clientX;
    
    // Evaluate if mouse pointer is in 75% edge-scrolling zones
    const rect = canvas.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const pctX = relX / rect.width;
    
    if (pctX >= 0.75) {
      edgeScrollSpeed = ((pctX - 0.75) / 0.25) * 5.0; // scroll forward (max 5s/sec)
    } else if (pctX <= 0.25) {
      edgeScrollSpeed = ((pctX - 0.25) / 0.25) * 5.0; // scroll backward (max -5s/sec)
    } else {
      edgeScrollSpeed = 0;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    canvas.classList.remove('grabbing');
    if (animId) cancelAnimationFrame(animId);
    
    const track = tracks[trackNum];
    let stems = [];
    if (track.stems.main.exists) stems.push(track.stems.main);
    if (track.stems.vocals.exists) stems.push(track.stems.vocals);
    track.stems.inst.audios.forEach(item => stems.push(item));
    
    const finalTime = (stems.length > 0) ? stems[0].audio.currentTime : startTime;
    
    // Start HTML5 audios immediately
    if (wasPlaying && track.isPlaying) {
      stems.forEach(stem => {
        stem.audio.volume = 0;
        stem.audio.currentTime = finalTime;
        stem.audio.preservesPitch = false;
        stem.audio.playbackRate = track.speedVal;
        stem.audio.play().then(() => {
          let startFade = performance.now();
          function fadeIn() {
            const elapsed = performance.now() - startFade;
            if (elapsed < 100) {
              stem.audio.volume = elapsed / 100;
              requestAnimationFrame(fadeIn);
            } else {
              stem.audio.volume = 1.0;
            }
          }
          fadeIn();
        }).catch(() => {});
      });
    } else {
      stems.forEach(stem => {
        stem.audio.currentTime = finalTime;
      });
    }
    
    // Fade out scratch sources over 150ms for gapless handover
    const sourcesToClean = [...scratchSources];
    scratchSources = [];
    
    sourcesToClean.forEach(item => {
      try {
        item.gain.gain.setValueAtTime(1.0, audioCtx.currentTime);
        item.gain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.15);
        
        // Match playback rate to normal forward speed during handover
        item.source.playbackRate.setValueAtTime(1.0, audioCtx.currentTime);
        
        setTimeout(() => {
          try {
            item.source.stop();
            item.source.disconnect();
            item.gain.disconnect();
          } catch (err) {}
        }, 160);
      } catch (err) {
        try { item.source.disconnect(); item.gain.disconnect(); } catch (e) {}
      }
    });
  });
}

function setupPreviewCanvasScratching(canvas) {
  let isDragging = false;
  let startX = 0;
  let startTime = 0;
  let wasPlaying = false;
  let lastX = 0;
  let scratchSources = [];
  let animId = null;

  // Scratch loop parameters
  let lastFrameTime = 0;
  let lastPlayheadTime = 0;
  let currentClientX = 0;
  let edgeScrollSpeed = 0;
  let scratchDirection = null;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (previewVisMode !== 'waveform') return;
    
    let stems = [];
    if (previewStems.main.exists) stems.push({ stem: previewStems.main, gainNode: previewStems.main.gainNode });
    if (previewStems.vocals.exists) stems.push({ stem: previewStems.vocals, gainNode: previewStems.vocals.gainNode });
    previewStems.inst.audios.forEach(item => {
      stems.push({ stem: item, gainNode: previewStems.inst.gainNode });
    });
    
    if (stems.length === 0) return;
    const refAudio = stems[0].stem.audio;
    if (!refAudio || isNaN(refAudio.duration) || refAudio.duration === 0) return;
    
    isDragging = true;
    startX = e.clientX;
    lastX = e.clientX;
    currentClientX = e.clientX;
    startTime = refAudio.currentTime;
    wasPlaying = previewIsPlaying;
    
    // Pause HTML5 preview audios
    stems.forEach(s => s.stem.audio.pause());
    
    // Initialize frame calculations
    lastFrameTime = performance.now();
    lastPlayheadTime = startTime;
    edgeScrollSpeed = 0;
    scratchDirection = null;
    scratchSources = [];
    
    const width = canvas.width;
    const visibleSeconds = 30;
    const pixelsPerSecond = width / visibleSeconds;
    let audioPlayheadTime = startTime;

    function scratchLoop() {
      if (!isDragging) return;
      animId = requestAnimationFrame(scratchLoop);
      
      const now = performance.now();
      const deltaTime = (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      
      if (deltaTime <= 0) return;
      
      if (edgeScrollSpeed !== 0) {
        startTime += edgeScrollSpeed * deltaTime;
        startTime = Math.max(0, Math.min(refAudio.duration - 0.02, startTime));
      }
      
      const dx = currentClientX - startX;
      const timeDelta = (dx / pixelsPerSecond) * 1.0;
      let newTime = startTime - timeDelta;
      
      if (newTime < 0) {
        newTime = 0;
        startX = currentClientX - (startTime * pixelsPerSecond / 1.0);
      } else if (newTime > refAudio.duration - 0.02) {
        newTime = refAudio.duration - 0.02;
        startX = currentClientX + ((refAudio.duration - 0.02 - startTime) * pixelsPerSecond / 1.0);
      }
      
      // 1:1 direct tracking (no lag)
      const dtAudio = newTime - audioPlayheadTime;
      const secondsPerSecond = dtAudio / deltaTime;
      
      let targetRate = secondsPerSecond;
      if (Math.abs(targetRate) >= 1.0) {
         targetRate = Math.sign(targetRate) * Math.pow(Math.abs(targetRate), 0.65);
      }
      targetRate = Math.max(-50.0, Math.min(50.0, targetRate));
      
      // Force waveform to stick perfectly to the mouse
      audioPlayheadTime = newTime;
      
      const isForward = (targetRate >= 0);
      const absRate = Math.abs(targetRate);
      
      if (scratchDirection === null || scratchDirection !== isForward) {
        scratchSources.forEach(item => {
          try { item.source.stop(); item.source.disconnect(); item.gain.disconnect(); } catch (err) {}
        });
        scratchSources = [];
        scratchDirection = isForward;
        
        if (wasPlaying) {
          stems.forEach(s => {
            const buf = isForward ? s.stem.buffer : s.stem.reversedBuffer;
            if (buf) {
              try {
                const srcNode = previewAudioCtx.createBufferSource();
                srcNode.buffer = buf;
                srcNode.loop = false;
                
                const gainNode = previewAudioCtx.createGain();
                srcNode.connect(gainNode);
                gainNode.connect(s.gainNode);
                
                const startPos = isForward ? audioPlayheadTime : (buf.duration - audioPlayheadTime);
                srcNode.start(0, Math.max(0, startPos));
                srcNode.playbackRate.setValueAtTime(absRate, previewAudioCtx.currentTime);
                
                scratchSources.push({ source: srcNode, gain: gainNode, stem: s.stem });
              } catch (err) {}
            }
          });
        }
      } else {
        scratchSources.forEach(item => {
          item.source.playbackRate.setTargetAtTime(absRate, previewAudioCtx.currentTime, 0.015);
        });
      }
      
      stems.forEach(s => {
        s.stem.audio.currentTime = audioPlayheadTime;
      });
      
      updatePreviewProgress();
    }
    
    animId = requestAnimationFrame(scratchLoop);
    canvas.classList.add('grabbing');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    currentClientX = e.clientX;
    
    // Evaluate if mouse pointer is in 75% edge-scrolling zones
    const rect = canvas.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const pctX = relX / rect.width;
    
    if (pctX >= 0.75) {
      edgeScrollSpeed = ((pctX - 0.75) / 0.25) * 5.0; // scroll forward (max 5s/sec)
    } else if (pctX <= 0.25) {
      edgeScrollSpeed = ((pctX - 0.25) / 0.25) * 5.0; // scroll backward (max -5s/sec)
    } else {
      edgeScrollSpeed = 0;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    canvas.classList.remove('grabbing');
    if (animId) cancelAnimationFrame(animId);
    
    let stems = [];
    if (previewStems.main.exists) stems.push(previewStems.main);
    if (previewStems.vocals.exists) stems.push(previewStems.vocals);
    previewStems.inst.audios.forEach(item => stems.push(item));
    
    const finalTime = (stems.length > 0) ? stems[0].audio.currentTime : startTime;
    
    if (wasPlaying && previewIsPlaying) {
      stems.forEach(stem => {
        stem.audio.volume = 0;
        stem.audio.currentTime = finalTime;
        stem.audio.play().then(() => {
          let startFade = performance.now();
          function fadeIn() {
            const elapsed = performance.now() - startFade;
            if (elapsed < 100) {
              stem.audio.volume = elapsed / 100;
              requestAnimationFrame(fadeIn);
            } else {
              stem.audio.volume = 1.0;
            }
          }
          fadeIn();
        }).catch(() => {});
      });
    } else {
      stems.forEach(stem => {
        stem.audio.currentTime = finalTime;
      });
    }
    
    const sourcesToClean = [...scratchSources];
    scratchSources = [];
    
    sourcesToClean.forEach(item => {
      try {
        item.gain.gain.setValueAtTime(1.0, previewAudioCtx.currentTime);
        item.gain.gain.linearRampToValueAtTime(0.0, previewAudioCtx.currentTime + 0.15);
        
        item.source.playbackRate.setValueAtTime(1.0, previewAudioCtx.currentTime);
        
        setTimeout(() => {
          try {
            item.source.stop();
            item.source.disconnect();
            item.gain.disconnect();
          } catch (err) {}
        }, 160);
      } catch (err) {
        try { item.source.disconnect(); item.gain.disconnect(); } catch (e) {}
      }
    });
  });
}

// Effect Settings Modal Logic
let currentSampleSettingsTarget = null;

function closeSampleSettings() {
  document.getElementById('sample-settings-window')?.classList.remove('show');
  currentSampleSettingsTarget = null;
}

function openSampleSettings({ trackNum = null, buttonIndex, preview = false }) {
  if (!Number.isInteger(buttonIndex) || buttonIndex < 0 || buttonIndex > 7) return;
  if (!preview && ![1, 2].includes(trackNum)) return;

  const soundData = preview
    ? previewSoundButtons[buttonIndex]
    : tracks[trackNum].soundButtons[buttonIndex];
  if (!soundData?.buffer) return;

  currentSampleSettingsTarget = { trackNum, buttonIndex, preview };
  const currentMode = preview
    ? previewSampleModes[buttonIndex]
    : tracks[trackNum].sampleModes[buttonIndex];
  const title = document.getElementById('sample-settings-title');
  const onTop = document.getElementById('sampleModeOnTop');
  const restart = document.getElementById('sampleModeRestart');
  if (title) {
    title.textContent = preview
      ? `PREVIEW - EFFECT ${buttonIndex + 1}`
      : `TRACK ${trackNum} - EFFECT ${buttonIndex + 1}`;
  }
  if (onTop) onTop.checked = currentMode !== 'restart';
  if (restart) restart.checked = currentMode === 'restart';
  document.getElementById('sample-settings-window')?.classList.add('show');
}

setTimeout(() => {
  const settingsWindow = document.getElementById('sample-settings-window');
  const settingsHeader = document.getElementById('sample-settings-header');
  if (settingsWindow && settingsHeader && typeof makeElementDraggable === 'function') {
    makeElementDraggable(settingsWindow, settingsHeader);
  }
}, 500);

document.getElementById('btn-close-sample-settings')
  ?.addEventListener('click', closeSampleSettings);
document.getElementById('btn-close-sample-settings-x')
  ?.addEventListener('click', closeSampleSettings);

document.getElementById('btn-save-sample-settings')
  ?.addEventListener('click', () => {
    if (!currentSampleSettingsTarget) return;
    const { trackNum, buttonIndex, preview } = currentSampleSettingsTarget;
    const mode = document.getElementById('sampleModeRestart')?.checked
      ? 'restart'
      : 'ontop';
    if (preview) {
      previewSampleModes[buttonIndex] = mode;
    } else {
      tracks[trackNum].sampleModes[buttonIndex] = mode;
    }
    logConsole(
      `Effect: ${preview ? 'Preview' : `Track ${trackNum}`} button ${buttonIndex + 1} set to ${mode === 'restart' ? 'RESTART' : 'PLAY ON TOP'}`,
      'system'
    );
    closeSampleSettings();
  });

document.getElementById('btn-remove-sample-settings')
  ?.addEventListener('click', () => {
    if (!currentSampleSettingsTarget) return;
    const { trackNum, buttonIndex, preview } = currentSampleSettingsTarget;
    if (preview) {
      clearPreviewSampleEffect(buttonIndex);
    } else {
      clearTrackSampleEffect(trackNum, buttonIndex);
    }
    logConsole(
      `Effect: Removed ${preview ? 'Preview' : `Track ${trackNum}`} button ${buttonIndex + 1}`,
      'system'
    );
    closeSampleSettings();
  });

// Cue Settings Modal Logic
let currentCueSettingsTrack = null;
let currentCueSettingsBtnIdx = null;

function openCueSettings(trackNum, btnIdx) {
  currentCueSettingsTrack = trackNum;
  currentCueSettingsBtnIdx = btnIdx;
  
  const windowEl = document.getElementById('cue-settings-window');
  const title = document.getElementById('cue-settings-title');
  const modePlay = document.getElementById('cueModePlay');
  const modeHold = document.getElementById('cueModeHold');
  const keybindInput = document.getElementById('cue-keybind-input');
  
  if (windowEl && title) {
    title.textContent = `TRACK ${trackNum} - CUE ${btnIdx + 1}`;
    setKeybindInputValue(keybindInput, cueKeybindings[btnIdx] || '');
    
    const currentMode = tracks[trackNum].cueModes[btnIdx] || 'play';
    if (currentMode === 'hold') {
      modeHold.checked = true;
    } else {
      modePlay.checked = true;
    }
    
    windowEl.classList.add('show');
  }
}

// Make window draggable
setTimeout(() => {
  const cueWindow = document.getElementById('cue-settings-window');
  if (cueWindow) {
    const cueHeader = document.getElementById('cue-settings-header');
    if (typeof makeElementDraggable === 'function') {
      makeElementDraggable(cueWindow, cueHeader);
    }
  }
}, 500);

const btnCloseCue = document.getElementById('btn-close-cue-settings');
const btnCloseCueX = document.getElementById('btn-close-cue-settings-x');

function closeCueSettings() {
  const w = document.getElementById('cue-settings-window');
  if (w) w.classList.remove('show');
}

if (btnCloseCue) btnCloseCue.addEventListener('click', closeCueSettings);
if (btnCloseCueX) btnCloseCueX.addEventListener('click', closeCueSettings);

const btnRemoveCue = document.getElementById('btn-remove-cue-settings');
if (btnRemoveCue) {
  btnRemoveCue.addEventListener('click', () => {
    if (currentCueSettingsTrack !== null && currentCueSettingsBtnIdx !== null) {
      const track = tracks[currentCueSettingsTrack];
      track.hotCues[currentCueSettingsBtnIdx] = null;
      track.cueModes[currentCueSettingsBtnIdx] = 'play';
      track.soundButtons[currentCueSettingsBtnIdx] = { path: '', name: 'DROP FILE', buffer: null };
      clearEndSyncCueAssignmentsForCue(currentCueSettingsTrack, currentCueSettingsBtnIdx);
      
      const btn = document.getElementById(`sound-btn-${currentCueSettingsTrack}-${currentCueSettingsBtnIdx}`);
      if (btn) {
        renderEmptySoundButtonLabel(btn);
        btn.classList.remove('loaded');
        btn.classList.remove('cue-draggable');
        btn.draggable = false;
        btn.style.color = '';
        btn.style.borderColor = '';
        btn.title = '';
      }
      if (typeof logConsole === 'function') {
        logConsole(`System: Removed Hot Cue ${currentCueSettingsBtnIdx + 1} from Track ${currentCueSettingsTrack}`, 'system');
      }
    }
    closeCueSettings();
  });
}

const btnSaveCue = document.getElementById('btn-save-cue-settings');
if (btnSaveCue) {
  btnSaveCue.addEventListener('click', () => {
    if (currentCueSettingsTrack !== null && currentCueSettingsBtnIdx !== null) {
      const modeHold = document.getElementById('cueModeHold');
      tracks[currentCueSettingsTrack].cueModes[currentCueSettingsBtnIdx] = modeHold.checked ? 'hold' : 'play';
      const keybindInput = document.getElementById('cue-keybind-input');
      cueKeybindings[currentCueSettingsBtnIdx] =
        keybindInput?.dataset.code || '';
      localStorage.setItem(
        'notoMixer_cueKeybindings',
        JSON.stringify(cueKeybindings)
      );
      persistUserSettings();
    }
    closeCueSettings();
  });
}

// Signal the main process that the app is completely loaded and ready to be shown
setTimeout(() => {
  ipcRenderer.send('app-ready');
}, 250);
