const fs = require('fs');
const path = require('path');

function parseConfigBoolean(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNotoMixerConfig(contents, appVersion = '0.0.0') {
  const parsed = {
    version: String(appVersion || '0.0.0'),
    evaluation: false,
    errorJingle: true,
    noAudioLoadedFallback: true,
    enableSpectrum: true,
    legacyMode: false,
    exclusiveMode: false,
    showAudioLevel: true
  };
  let section = '';

  String(contents || '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) return;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      return;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) return;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (section === 'application information' && key === 'evaluation') {
      parsed.evaluation = parseConfigBoolean(value, parsed.evaluation);
    } else if (section === 'audio settings' && key === 'error-jingle') {
      parsed.errorJingle = parseConfigBoolean(value, parsed.errorJingle);
    } else if (
      section === 'audio settings' &&
      key === 'no-audioloaded-fallback'
    ) {
      parsed.noAudioLoadedFallback = parseConfigBoolean(
        value,
        parsed.noAudioLoadedFallback
      );
    } else if (section === 'visualizer' && key === 'enable-spectrum') {
      parsed.enableSpectrum = parseConfigBoolean(value, parsed.enableSpectrum);
    } else if (section === 'debug settings' && key === 'legacy-mode') {
      parsed.legacyMode = parseConfigBoolean(value, parsed.legacyMode);
    } else if (section === 'debug settings' && key === 'exclusive-mode') {
      parsed.exclusiveMode = parseConfigBoolean(value, parsed.exclusiveMode);
    } else if (section === 'debug settings' && key === 'show-audiolevel') {
      parsed.showAudioLevel = parseConfigBoolean(value, parsed.showAudioLevel);
    }
  });

  return Object.freeze(parsed);
}

function loadNotoMixerConfig(baseDirectory, appVersion) {
  const configPath = path.join(baseDirectory, 'config.notomixer');
  try {
    return parseNotoMixerConfig(fs.readFileSync(configPath, 'utf8'), appVersion);
  } catch (error) {
    console.warn(`Unable to load ${configPath}; using defaults.`, error.message);
    return parseNotoMixerConfig('', appVersion);
  }
}

module.exports = {
  loadNotoMixerConfig,
  parseNotoMixerConfig
};
