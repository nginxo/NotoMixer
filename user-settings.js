const fs = require('fs');
const path = require('path');

const USER_SETTINGS_SECTIONS = Object.freeze([
  {
    name: 'UI Layout',
    entries: [
      ['layout-mode', 'notoMixer_layoutMode', 'default'],
      ['explorer-height', 'notoMixer_explorerHeight', '180'],
      ['stacked-waveform-height', 'notoMixer_stackedHeight', '250'],
      ['working-directory', 'notoMixer_workingDir', '']
    ]
  },
  {
    name: 'Audio Output',
    entries: [
      ['main-device', 'notoMixer_mainAudioDevice', 'default'],
      ['preview-device', 'notoMixer_previewAudioDevice', 'default']
    ]
  },
  {
    name: 'Music Settings',
    entries: [
      ['skip-opening-silence', 'notoMixer_skipOpeningSilence', 'false'],
      ['skip-ending-silence', 'notoMixer_skipEndingSilence', 'false'],
      ['music-ending-warning', 'notoMixer_musicEndingWarning', 'false'],
      ['end-sync-t1-seconds', 'notoMixer_endSyncSeconds_1', '30'],
      ['end-sync-t1-mix-enabled', 'notoMixer_endSyncMixEnabled_1', 'false'],
      ['end-sync-t1-mix-seconds', 'notoMixer_endSyncMixSeconds_1', '5'],
      ['end-sync-t1-fade-in', 'notoMixer_endSyncFadeInEnabled_1', 'false'],
      ['end-sync-t1-fade-out', 'notoMixer_endSyncFadeOutEnabled_1', 'false'],
      ['end-sync-t1-fade-seconds', 'notoMixer_endSyncFadeSeconds_1', '5'],
      ['end-sync-t2-seconds', 'notoMixer_endSyncSeconds_2', '30'],
      ['end-sync-t2-mix-enabled', 'notoMixer_endSyncMixEnabled_2', 'false'],
      ['end-sync-t2-mix-seconds', 'notoMixer_endSyncMixSeconds_2', '5'],
      ['end-sync-t2-fade-in', 'notoMixer_endSyncFadeInEnabled_2', 'false'],
      ['end-sync-t2-fade-out', 'notoMixer_endSyncFadeOutEnabled_2', 'false'],
      ['end-sync-t2-fade-seconds', 'notoMixer_endSyncFadeSeconds_2', '5']
    ]
  },
  {
    name: 'EQs and Sliders',
    entries: [
      ['center-snap-enabled', 'notoMixer_snapEnabled', 'false'],
      ['center-snap-threshold', 'notoMixer_snapThreshold', '5']
    ]
  },
  {
    name: 'Keybinds',
    entries: [
      [
        'button-bindings',
        'notoMixer_keyboardBindings',
        '{"auto":"KeyA","loopIn":"KeyI","loopOut":"KeyO","loopExit":"KeyX","sync":"KeyS","endSync":"KeyE","quantize":"KeyQ"}'
      ],
      ['cue-bindings', 'notoMixer_cueKeybindings', '[]']
    ]
  },
  {
    name: 'Controller Binds',
    entries: [
      ['midi-controller', 'notoMixer_midiControllerConfig', '{}'],
      ['jog-max-speed', 'notoMixer_jogMaxSpeed', '16'],
      ['jog-inertia-seconds', 'notoMixer_jogInertiaSeconds', '0.7']
    ]
  },
  {
    name: 'Macros',
    entries: [
      ['locked-macros', 'notoMixer_lockedMacros', '{"version":1,"tracks":{"1":[],"2":[]}}']
    ]
  },
  {
    name: 'Zoom Preferences',
    entries: [
      ['text', 'notoMixer_zoomText', '100'],
      ['waveform', 'notoMixer_zoomWaveform', '100'],
      ['buttons', 'notoMixer_zoomButtons', '100'],
      ['cover-art', 'notoMixer_zoomCover', '100']
    ]
  }
]);

function getUserSettingsPath(baseDirectory) {
  return path.join(baseDirectory, 'settings', 'userSettings.notomixer');
}

function parseUserSettings(contents) {
  const document = new Map();
  let section = '';

  String(contents || '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) return;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!document.has(section)) document.set(section, new Map());
      return;
    }

    const separatorIndex = line.indexOf('=');
    if (!section || separatorIndex < 0) return;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    document.get(section).set(key, value);
  });

  return document;
}

function readUserSettings(baseDirectory) {
  const settingsPath = getUserSettingsPath(baseDirectory);
  try {
    return parseUserSettings(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to read ${settingsPath}.`, error.message);
    }
    return new Map();
  }
}

function hydrateUserSettings(baseDirectory, storage) {
  const document = readUserSettings(baseDirectory);
  let loadedEntries = 0;
  const musicSection = document.get('Music Settings');
  const eqSection = document.get('EQs and Sliders');

  [
    ['center-snap-enabled', 'notoMixer_snapEnabled'],
    ['center-snap-threshold', 'notoMixer_snapThreshold']
  ].forEach(([fileKey, storageKey]) => {
    if (!eqSection?.has(fileKey) && musicSection?.has(fileKey)) {
      storage.setItem(storageKey, musicSection.get(fileKey));
      loadedEntries += 1;
    }
  });

  USER_SETTINGS_SECTIONS.forEach(sectionDefinition => {
    const section = document.get(sectionDefinition.name);
    if (!section) return;
    sectionDefinition.entries.forEach(([fileKey, storageKey]) => {
      if (!section.has(fileKey)) return;
      storage.setItem(storageKey, section.get(fileKey));
      loadedEntries += 1;
    });
  });

  return loadedEntries;
}

function cleanSettingValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function serializeUserSettings(document) {
  const lines = [];
  const writtenSections = new Set();

  const writeSection = sectionName => {
    if (lines.length > 0) lines.push('');
    lines.push(`[${sectionName}]`);
    const entries = document.get(sectionName);
    if (entries) {
      entries.forEach((value, key) => {
        lines.push(`${key}=${cleanSettingValue(value)}`);
      });
    }
    writtenSections.add(sectionName);
  };

  USER_SETTINGS_SECTIONS.forEach(section => writeSection(section.name));
  document.forEach((entries, sectionName) => {
    if (!writtenSections.has(sectionName)) writeSection(sectionName);
  });

  return `${lines.join('\n')}\n`;
}

function saveUserSettings(baseDirectory, storage) {
  const settingsPath = getUserSettingsPath(baseDirectory);
  const document = readUserSettings(baseDirectory);
  const uiLayoutSection = document.get('UI Layout');
  const musicSection = document.get('Music Settings');

  uiLayoutSection?.delete('explorer-layout');
  uiLayoutSection?.delete('explorer-width');
  musicSection?.delete('center-snap-enabled');
  musicSection?.delete('center-snap-threshold');

  USER_SETTINGS_SECTIONS.forEach(sectionDefinition => {
    if (!document.has(sectionDefinition.name)) {
      document.set(sectionDefinition.name, new Map());
    }
    const section = document.get(sectionDefinition.name);
    sectionDefinition.entries.forEach(([fileKey, storageKey, defaultValue]) => {
      const storedValue = storage.getItem(storageKey);
      section.set(
        fileKey,
        storedValue === null ? defaultValue : cleanSettingValue(storedValue)
      );
    });
  });

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, serializeUserSettings(document), 'utf8');
  return settingsPath;
}

module.exports = {
  getUserSettingsPath,
  hydrateUserSettings,
  parseUserSettings,
  readUserSettings,
  saveUserSettings,
  serializeUserSettings
};
