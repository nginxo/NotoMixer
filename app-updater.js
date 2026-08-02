const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const GITHUB_OWNER = 'nginxo';
const GITHUB_REPOSITORY = 'NotoMixer';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_USER_AGENT = 'NotoMixer-Updater';
const RELEASES_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases?per_page=20`;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function normalizeVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+){0,3}/);
  if (!match) return null;
  const parts = match[0].split('.').map(part => Number(part));
  if (parts.some(part => !Number.isSafeInteger(part) || part < 0)) return null;
  while (parts.length < 4) parts.push(0);
  return {
    display: match[0],
    parts
  };
}

function compareVersions(left, right) {
  const normalizedLeft = normalizeVersion(left);
  const normalizedRight = normalizeVersion(right);
  if (!normalizedLeft || !normalizedRight) return null;
  for (let index = 0; index < 4; index += 1) {
    if (normalizedLeft.parts[index] > normalizedRight.parts[index]) return 1;
    if (normalizedLeft.parts[index] < normalizedRight.parts[index]) return -1;
  }
  return 0;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': GITHUB_USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error(`GitHub release request returned ${response.statusCode}`);
        error.statusCode = response.statusCode;
        reject(error);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_JSON_BYTES) {
          request.destroy(new Error('GitHub release response is too large'));
        }
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('GitHub release response is invalid'));
        }
      });
    });
    request.setTimeout(8000, () => {
      request.destroy(new Error('GitHub release request timed out'));
    });
    request.on('error', reject);
  });
}

function isTrustedReleaseDownloadUrl(value, initialRequest = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (initialRequest) {
      const expectedPrefix =
        `/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/download/`.toLowerCase();
      return hostname === 'github.com'
        && url.pathname.toLowerCase().startsWith(expectedPrefix);
    }
    return hostname === 'github.com'
      || hostname.endsWith('.githubusercontent.com');
  } catch (error) {
    return false;
  }
}

function selectInstallerAsset(assets) {
  const candidates = (Array.isArray(assets) ? assets : [])
    .filter(asset => (
      asset
      && asset.state === 'uploaded'
      && typeof asset.name === 'string'
      && asset.name.toLowerCase().endsWith('.exe')
      && Number(asset.size) > 0
      && isTrustedReleaseDownloadUrl(asset.browser_download_url, true)
    ))
    .map(asset => {
      const name = asset.name.toLowerCase();
      let score = 0;
      if (name.includes('win64shipping')) score += 100;
      if (name.includes('notomixer')) score += 40;
      if (name.includes('win64') || name.includes('x64')) score += 20;
      if (name.includes('setup') || name.includes('installer')) score += 10;
      return { asset, score };
    })
    .sort((left, right) => right.score - left.score);

  const selected = candidates[0]?.asset;
  if (!selected) return null;
  return {
    name: path.basename(selected.name),
    size: Number(selected.size),
    digest: typeof selected.digest === 'string' ? selected.digest : '',
    downloadUrl: selected.browser_download_url
  };
}

async function checkForUpdate(currentVersion) {
  const releases = await requestJson(RELEASES_URL);
  const release = (Array.isArray(releases) ? releases : [])
    .filter(item => item && item.draft !== true && normalizeVersion(item.tag_name || item.name))
    .sort((left, right) => {
      const versionComparison = compareVersions(
        right.tag_name || right.name,
        left.tag_name || left.name
      );
      if (versionComparison) return versionComparison;
      return Date.parse(right.published_at || 0) - Date.parse(left.published_at || 0);
    })[0];
  if (!release) {
    return {
      available: false,
      currentVersion: normalizeVersion(currentVersion)?.display || String(currentVersion)
    };
  }
  const latestVersion = normalizeVersion(release.tag_name || release.name);
  const comparison = latestVersion
    ? compareVersions(latestVersion.display, currentVersion)
    : null;
  if (!latestVersion || comparison === null || comparison <= 0) {
    return {
      available: false,
      currentVersion: normalizeVersion(currentVersion)?.display || String(currentVersion)
    };
  }

  return {
    available: true,
    currentVersion: normalizeVersion(currentVersion)?.display || String(currentVersion),
    version: latestVersion.display,
    tagName: String(release.tag_name || ''),
    name: String(release.name || release.tag_name || `NotoMixer ${latestVersion.display}`),
    prerelease: release.prerelease === true,
    publishedAt: String(release.published_at || ''),
    notes: String(release.body || '').slice(0, 4000),
    asset: selectInstallerAsset(release.assets)
  };
}

function openDownloadResponse(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!isTrustedReleaseDownloadUrl(url, redirectCount === 0)) {
      reject(new Error('Untrusted update download URL'));
      return;
    }

    const request = https.get(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': GITHUB_USER_AGENT
      }
    }, response => {
      if (
        response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Too many update download redirects'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).href;
        openDownloadResponse(redirectUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Update download returned ${response.statusCode}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(15000, () => {
      request.destroy(new Error('Update download timed out'));
    });
    request.on('error', reject);
  });
}

function parseSha256Digest(value) {
  const match = String(value || '').match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : '';
}

async function downloadUpdate(release, tempRoot, onProgress = () => {}) {
  const asset = release?.asset;
  if (!asset || !asset.downloadUrl || !asset.name) {
    throw new Error('This release does not include a Windows installer');
  }
  if (!isTrustedReleaseDownloadUrl(asset.downloadUrl, true)) {
    throw new Error('The update installer URL is not trusted');
  }

  const updateDirectory = path.resolve(tempRoot, 'NotoMixer Updates');
  const installerName = path.basename(asset.name);
  if (!installerName.toLowerCase().endsWith('.exe')) {
    throw new Error('The update asset is not a Windows installer');
  }
  const installerPath = path.join(updateDirectory, installerName);
  const partialPath = `${installerPath}.download`;
  await fs.promises.mkdir(updateDirectory, { recursive: true });
  await fs.promises.rm(partialPath, { force: true });

  const response = await openDownloadResponse(asset.downloadUrl);
  const expectedBytes = Number(asset.size)
    || Number(response.headers['content-length'])
    || 0;
  const expectedDigest = parseSha256Digest(asset.digest);
  const hash = crypto.createHash('sha256');
  let receivedBytes = 0;

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(partialPath, { flags: 'wx' });
      response.on('data', chunk => {
        receivedBytes += chunk.length;
        hash.update(chunk);
        onProgress({
          receivedBytes,
          totalBytes: expectedBytes,
          percent: expectedBytes > 0
            ? Math.min(100, Math.round((receivedBytes / expectedBytes) * 100))
            : null
        });
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      response.pipe(output);
    });

    if (expectedBytes > 0 && receivedBytes !== expectedBytes) {
      throw new Error('The downloaded installer size does not match the release asset');
    }
    const actualDigest = hash.digest('hex');
    if (expectedDigest && actualDigest !== expectedDigest) {
      throw new Error('The downloaded installer failed SHA-256 verification');
    }

    await fs.promises.rm(installerPath, { force: true });
    await fs.promises.rename(partialPath, installerPath);
    return {
      installerPath,
      verified: Boolean(expectedDigest),
      receivedBytes
    };
  } catch (error) {
    response.destroy();
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  isTrustedReleaseDownloadUrl,
  normalizeVersion,
  selectInstallerAsset
};
