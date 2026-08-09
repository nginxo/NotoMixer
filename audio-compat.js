const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const pendingConversions = new Map();
const CACHE_FORMAT_VERSION = 'm4a-to-flac-v3';
const configuredCacheMaxBytes = Number(process.env.NOTOMIXER_AUDIO_CACHE_MAX_BYTES);
const CACHE_MAX_BYTES = Number.isFinite(configuredCacheMaxBytes) && configuredCacheMaxBytes > 0
  ? configuredCacheMaxBytes
  : 5 * 1024 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CONVERSION_TIMEOUT_MS = 5 * 60 * 1000;
const ANALYSIS_DECODE_TIMEOUT_MS = 5 * 60 * 1000;
const ANALYSIS_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const CACHE_DIRECTORY = process.env.NOTOMIXER_AUDIO_CACHE_DIRECTORY
  ? path.resolve(process.env.NOTOMIXER_AUDIO_CACHE_DIRECTORY)
  : path.join(os.tmpdir(), 'NotoMixer', 'audio-cache');
let lastCachePruneAt = 0;

function isM4aFile(filePath) {
  return path.extname(filePath).toLowerCase() === '.m4a';
}

function getFfmpegPath() {
  let ffmpegPath = process.env.NOTOMIXER_FFMPEG_PATH
    || path.join(__dirname, '.runtime', 'ffmpeg', 'bin', 'ffmpeg.exe');
  // Executables cannot run from inside app.asar. The installer unpacks the
  // pinned runtime, while __dirname still reports its logical ASAR path.
  ffmpegPath = ffmpegPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(`The bundled FFmpeg executable was not found at ${ffmpegPath}.`);
  }
  return ffmpegPath;
}

function getFfprobePath() {
  const ffprobePath = path.join(path.dirname(getFfmpegPath()), 'ffprobe.exe');
  if (!fs.existsSync(ffprobePath)) {
    throw new Error(`The bundled FFprobe executable was not found at ${ffprobePath}.`);
  }
  return ffprobePath;
}

function probeAudioCodec(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, codec = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(codec);
    };
    const timeout = setTimeout(() => {
      ffprobe.kill();
      finish(new Error(`FFprobe timed out while reading ${path.basename(filePath)}.`));
    }, 10000);
    ffprobe.stdout.on('data', chunk => {
      if (stdout.length < 1000) stdout += chunk.toString();
    });
    ffprobe.stderr.on('data', chunk => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    ffprobe.on('error', finish);
    ffprobe.on('close', code => {
      if (code === 0) {
        finish(null, stdout.trim().toLowerCase());
        return;
      }
      finish(new Error(
        `FFprobe could not inspect ${path.basename(filePath)}`
        + (stderr.trim() ? `: ${stderr.trim()}` : ` (exit code ${code})`)
      ));
    });
  });
}

async function requiresCompatibilityConversion(filePath) {
  if (!isM4aFile(filePath)) return false;
  try {
    return await probeAudioCodec(filePath) !== 'aac';
  } catch (error) {
    // Let FFmpeg provide a detailed error instead of passing an unidentified
    // and potentially unusable M4A stream directly to Chromium.
    return true;
  }
}

async function getCachePath(filePath) {
  const resolvedPath = path.resolve(filePath);
  const stats = await fs.promises.stat(resolvedPath);
  const cacheKey = crypto.createHash('sha256')
    .update(CACHE_FORMAT_VERSION)
    .update('\0')
    .update(resolvedPath.toLowerCase())
    .update('\0')
    .update(String(stats.size))
    .update('\0')
    .update(String(stats.mtimeMs))
    .digest('hex');
  await fs.promises.mkdir(CACHE_DIRECTORY, { recursive: true });
  return path.join(CACHE_DIRECTORY, `${cacheKey}.flac`);
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFfmpegPath(), [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'flac',
      '-compression_level', '5',
      outputPath
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      ffmpeg.kill();
      finish(new Error(`FFmpeg timed out while decoding ${path.basename(inputPath)}.`));
    }, CONVERSION_TIMEOUT_MS);
    ffmpeg.stderr.on('data', chunk => {
      if (stderr.length < 16000) stderr += chunk.toString();
    });
    ffmpeg.on('error', finish);
    ffmpeg.on('close', code => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(
        `FFmpeg could not decode ${path.basename(inputPath)}`
        + (stderr.trim() ? `: ${stderr.trim()}` : ` (exit code ${code})`)
      ));
    });
  });
}

function decodeAudioForAnalysis(filePaths, sampleRate = 11025) {
  const inputs = [...new Set(filePaths.map(filePath => path.resolve(filePath)))];
  if (inputs.length === 0) {
    return Promise.reject(new Error('No audio files were provided for analysis.'));
  }

  const safeSampleRate = Math.max(8000, Math.min(22050, Math.round(sampleRate)));
  const args = ['-hide_banner', '-loglevel', 'error'];
  inputs.forEach(inputPath => args.push('-i', inputPath));

  if (inputs.length === 1) {
    args.push('-map', '0:a:0');
  } else {
    const inputLabels = inputs.map((_, index) => `[${index}:a:0]`).join('');
    args.push(
      '-filter_complex',
      `${inputLabels}amix=inputs=${inputs.length}:duration=longest:normalize=1[analysis]`,
      '-map', '[analysis]'
    );
  }
  args.push(
    '-vn',
    '-ac', '1',
    '-ar', String(safeSampleRate),
    '-c:a', 'pcm_f32le',
    '-f', 'f32le',
    'pipe:1'
  );

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFfmpegPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      // Analysis is background work. Keep mixer/audio UI work ahead of FFmpeg
      // when the user starts performing before the library scan completes.
      os.setPriority(ffmpeg.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (error) {}
    const chunks = [];
    let outputBytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      ffmpeg.kill();
      finish(new Error(`FFmpeg analysis timed out for ${path.basename(inputs[0])}.`));
    }, ANALYSIS_DECODE_TIMEOUT_MS);

    ffmpeg.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > ANALYSIS_MAX_OUTPUT_BYTES) {
        ffmpeg.kill();
        finish(new Error(`Analysis output is too large for ${path.basename(inputs[0])}.`));
        return;
      }
      chunks.push(chunk);
    });
    ffmpeg.stderr.on('data', chunk => {
      if (stderr.length < 16000) stderr += chunk.toString();
    });
    ffmpeg.on('error', finish);
    ffmpeg.on('close', code => {
      if (settled) return;
      if (code === 0 && outputBytes >= 4) {
        finish(null, {
          pcm: Buffer.concat(chunks, outputBytes),
          sampleRate: safeSampleRate
        });
        return;
      }
      finish(new Error(
        `FFmpeg could not prepare ${path.basename(inputs[0])} for analysis`
        + (stderr.trim() ? `: ${stderr.trim()}` : ` (exit code ${code})`)
      ));
    });
  });
}

async function pruneAudioCache(
  cacheDirectory,
  preservePath,
  { force = false, targetBytes = CACHE_MAX_BYTES } = {}
) {
  const now = Date.now();
  if (!force && now - lastCachePruneAt < 60000) return;
  lastCachePruneAt = now;

  const entries = await fs.promises.readdir(cacheDirectory, { withFileTypes: true });
  const cachedFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.flac$/i.test(entry.name)) continue;
    const filePath = path.join(cacheDirectory, entry.name);
    const stats = await fs.promises.stat(filePath);
    const isProtected = filePath === preservePath || pendingConversions.has(filePath);
    const lastUsed = Math.max(stats.atimeMs, stats.mtimeMs);
    if (!isProtected && now - lastUsed > CACHE_MAX_AGE_MS) {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {}
      continue;
    }
    cachedFiles.push({ filePath, size: stats.size, lastUsed, isProtected });
  }

  let totalBytes = cachedFiles.reduce((total, file) => total + file.size, 0);
  cachedFiles.sort((a, b) => a.lastUsed - b.lastUsed);
  for (const file of cachedFiles) {
    if (totalBytes <= targetBytes) break;
    if (file.isProtected) continue;
    try {
      await fs.promises.unlink(file.filePath);
      totalBytes -= file.size;
    } catch (error) {}
  }
}

async function convertM4a(filePath, cachePath) {
  try {
    const cachedStats = await fs.promises.stat(cachePath);
    if (cachedStats.size > 0) {
      const now = new Date();
      await fs.promises.utimes(cachePath, now, cachedStats.mtime).catch(() => {});
      pruneAudioCache(path.dirname(cachePath), cachePath).catch(() => {});
      return cachePath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporaryPath = path.join(
    path.dirname(cachePath),
    `${path.basename(cachePath, '.flac')}.${process.pid}.${Date.now()}.tmp.flac`
  );

  try {
    const inputStats = await fs.promises.stat(filePath);
    const reservedBytes = Math.min(CACHE_MAX_BYTES, inputStats.size * 2);
    await pruneAudioCache(path.dirname(cachePath), cachePath, {
      force: true,
      targetBytes: Math.max(0, CACHE_MAX_BYTES - reservedBytes)
    });
    await runFfmpeg(path.resolve(filePath), temporaryPath);
    const outputStats = await fs.promises.stat(temporaryPath);
    if (outputStats.size === 0) {
      throw new Error(`FFmpeg produced an empty file for ${path.basename(filePath)}.`);
    }
    try {
      await fs.promises.rename(temporaryPath, cachePath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
    await pruneAudioCache(path.dirname(cachePath), cachePath, { force: true });
    return cachePath;
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function getCompatibleAudioPath(filePath) {
  if (!await requiresCompatibilityConversion(filePath)) return filePath;
  const cachePath = await getCachePath(filePath);
  if (!pendingConversions.has(cachePath)) {
    const conversion = convertM4a(filePath, cachePath)
      .finally(() => pendingConversions.delete(cachePath));
    pendingConversions.set(cachePath, conversion);
  }
  return pendingConversions.get(cachePath);
}

async function getCompatibleAudioPaths(filePaths) {
  const uniquePaths = [...new Set(filePaths)];
  const compatiblePaths = await Promise.all(uniquePaths.map(getCompatibleAudioPath));
  return new Map(uniquePaths.map((filePath, index) => [filePath, compatiblePaths[index]]));
}

module.exports = {
  decodeAudioForAnalysis,
  getCompatibleAudioPath,
  getCompatibleAudioPaths,
  getFfmpegPath,
  isM4aFile
};
