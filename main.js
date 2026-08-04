const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { pathToFileURL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const appUpdater = require('./app-updater');
const { loadNotoMixerConfig } = require('./notomixer-config');

// Disable the default application menu bar (File, Edit, View, etc.)
Menu.setApplicationMenu(null);

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let mainWindow;
let targetPortName = '';

let splash;
const TABLET_CONTROLLER_PORT = 37840;
const TABLET_CONTROLLER_SESSION_ID = randomUUID();
const NOTOMIXER_ROOT = process.env.NOTOMIXER_INSTALL_ROOT
  ? path.resolve(process.env.NOTOMIXER_INSTALL_ROOT)
  : app.isPackaged
    ? path.resolve(path.dirname(process.execPath), '..')
    : __dirname;
const PUBLIC_ASSETS_ROOT = path.join(NOTOMIXER_ROOT, 'assets');
let tabletControllerServer = null;
let tabletControllerWebSocketServer = null;
let tabletControllerPort = 0;
let availableAppUpdate = null;
let downloadedUpdatePath = '';
let updateCheckPromise = null;
let updateDownloadPromise = null;
let tabletControllerState = {
  type: 'state',
  snap: {
    enabled: false,
    thresholdPct: 5
  },
  libraryAnalysis: {
    inProgress: true,
    blocking: false,
    total: 0,
    completed: 0,
    failed: 0,
    current: ''
  },
  tracks: []
};
let tabletControllerLibrary = {
  type: 'library',
  playlists: [],
  songs: []
};
let tabletLibraryCoverPaths = new Map();
const tabletCoverPaths = { 1: '', 2: '' };
const tabletCoverVersions = { 1: 0, 2: 0 };

function serializeAvailableUpdate(release) {
  if (!release?.available) return null;
  return {
    currentVersion: release.currentVersion,
    version: release.version,
    tagName: release.tagName,
    name: release.name,
    prerelease: release.prerelease === true,
    publishedAt: release.publishedAt,
    notes: release.notes,
    downloadAvailable: Boolean(release.asset),
    asset: release.asset
      ? {
          name: release.asset.name,
          size: release.asset.size,
          hasDigest: /^sha256:[a-f0-9]{64}$/i.test(release.asset.digest || '')
        }
      : null
  };
}

async function checkForAppUpdate() {
  const updateConfig = loadNotoMixerConfig(NOTOMIXER_ROOT, app.getVersion());
  if (updateConfig.skipUpdateRequest) {
    availableAppUpdate = null;
    downloadedUpdatePath = '';
    return {
      status: 'disabled',
      currentVersion: app.getVersion()
    };
  }
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = appUpdater.checkForUpdate(app.getVersion())
    .then(result => {
      if (result.available) {
        if (availableAppUpdate?.version !== result.version) {
          downloadedUpdatePath = '';
        }
        availableAppUpdate = result;
        return {
          status: 'available',
          release: serializeAvailableUpdate(result)
        };
      }
      availableAppUpdate = null;
      downloadedUpdatePath = '';
      return {
        status: 'current',
        currentVersion: result.currentVersion || app.getVersion()
      };
    })
    .finally(() => {
      updateCheckPromise = null;
    });
  return updateCheckPromise;
}

function scheduleAutomaticUpdateCheck() {
  setTimeout(() => {
    checkForAppUpdate()
      .then(result => {
        if (
          result.status === 'available'
          && mainWindow
          && !mainWindow.isDestroyed()
        ) {
          mainWindow.webContents.send('app-update:available', result.release);
        } else if (
          result.status === 'disabled'
          && mainWindow
          && !mainWindow.isDestroyed()
        ) {
          mainWindow.webContents.send('app-update:status', result);
        }
      })
      // Startup checks intentionally fail silently when the network or GitHub
      // is unavailable, or when the repository has no published releases yet.
      .catch(() => {});
  }, 3000);
}

function getLocalNetworkAddresses() {
  const addresses = [];
  Object.values(os.networkInterfaces()).forEach(entries => {
    (entries || []).forEach(entry => {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    });
  });
  return [...new Set(addresses)];
}

function getTabletControllerInfo() {
  const ready = Boolean(
    tabletControllerServer &&
    tabletControllerServer.listening &&
    tabletControllerPort
  );
  return {
    ready,
    port: tabletControllerPort,
    urls: ready
      ? getLocalNetworkAddresses().map(
          address => `http://${address}:${tabletControllerPort}`
        )
      : [],
    connectedClients:
      tabletControllerWebSocketServer
        ? tabletControllerWebSocketServer.clients.size
        : 0
  };
}

function getTabletContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function sendTabletFile(response, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': getTabletContentType(filePath),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'"
    });
    response.end(data);
  });
}

function handleTabletControllerRequest(request, response) {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end();
    return;
  }

  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host || 'localhost'}`
  );
  const tabletRoot = path.join(__dirname, 'tablet-controller');
  const routeFiles = {
    '/': path.join(tabletRoot, 'index.html'),
    '/index.html': path.join(tabletRoot, 'index.html'),
    '/style.css': path.join(tabletRoot, 'style.css'),
    '/app.js': path.join(tabletRoot, 'app.js'),
    '/logo.svg': path.join(PUBLIC_ASSETS_ROOT, 'logo.svg')
  };

  const coverMatch = requestUrl.pathname.match(/^\/cover\/([12])$/);
  if (coverMatch) {
    const trackNum = Number(coverMatch[1]);
    const coverPath = tabletCoverPaths[trackNum];
    const safeCover =
      coverPath && fs.existsSync(coverPath)
        ? coverPath
        : path.join(PUBLIC_ASSETS_ROOT, 'logo.svg');
    sendTabletFile(response, safeCover);
    return;
  }

  if (requestUrl.pathname === '/library-cover') {
    const songId = (requestUrl.searchParams.get('id') || '').slice(0, 1000);
    const coverPath = tabletLibraryCoverPaths.get(songId);
    const safeCover = coverPath && fs.existsSync(coverPath)
      ? coverPath
      : path.join(PUBLIC_ASSETS_ROOT, 'logo.svg');
    sendTabletFile(response, safeCover);
    return;
  }

  const filePath = routeFiles[requestUrl.pathname];
  if (!filePath) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  sendTabletFile(response, filePath);
}

function sanitizeTabletControllerState(nextState) {
  const requestedMaxSpeed = Number(nextState?.jogPhysics?.maxSpeed);
  const requestedInertia = Number(nextState?.jogPhysics?.inertiaSeconds);
  const jogPhysics = {
    maxSpeed: Number.isFinite(requestedMaxSpeed)
      ? Math.max(2, Math.min(32, requestedMaxSpeed))
      : 16,
    inertiaSeconds: Number.isFinite(requestedInertia)
      ? Math.max(0, Math.min(5, requestedInertia))
      : 0.7
  };
  const requestedSnapThreshold = Number(nextState?.snap?.thresholdPct);
  const snap = {
    enabled: nextState?.snap?.enabled === true,
    thresholdPct: Number.isFinite(requestedSnapThreshold)
      ? Math.max(1, Math.min(15, requestedSnapThreshold))
      : 5
  };
  const tracks = Array.isArray(nextState?.tracks)
    ? nextState.tracks.slice(0, 2).map((track, index) => {
        const trackNum = index + 1;
        const nextCoverPath =
          typeof track.coverPath === 'string' ? track.coverPath : '';
        if (tabletCoverPaths[trackNum] !== nextCoverPath) {
          tabletCoverPaths[trackNum] = nextCoverPath;
          tabletCoverVersions[trackNum] += 1;
        }
        const { coverPath, ...publicTrack } = track;
        return {
          ...publicTrack,
          coverVersion: tabletCoverVersions[trackNum]
        };
      })
    : [];
  const requestedAnalysisTotal = Number(nextState?.libraryAnalysis?.total);
  const requestedAnalysisCompleted = Number(nextState?.libraryAnalysis?.completed);
  const requestedAnalysisFailed = Number(nextState?.libraryAnalysis?.failed);
  const libraryAnalysis = {
    inProgress: nextState?.libraryAnalysis?.inProgress === true,
    blocking: nextState?.libraryAnalysis?.blocking === true,
    current: typeof nextState?.libraryAnalysis?.current === 'string'
      ? nextState.libraryAnalysis.current.slice(0, 300)
      : '',
    total: Number.isFinite(requestedAnalysisTotal)
      ? Math.max(0, Math.floor(requestedAnalysisTotal))
      : 0,
    completed: Number.isFinite(requestedAnalysisCompleted)
      ? Math.max(0, Math.floor(requestedAnalysisCompleted))
      : 0,
    failed: Number.isFinite(requestedAnalysisFailed)
      ? Math.max(0, Math.floor(requestedAnalysisFailed))
      : 0
  };
  libraryAnalysis.completed = Math.min(libraryAnalysis.completed, libraryAnalysis.total);
  libraryAnalysis.failed = Math.min(libraryAnalysis.failed, libraryAnalysis.completed);
  return { type: 'state', jogPhysics, snap, libraryAnalysis, tracks };
}

function sanitizeTabletControllerLibrary(nextLibrary) {
  const playlists = Array.isArray(nextLibrary?.playlists)
    ? nextLibrary.playlists
        .filter(value => typeof value === 'string')
        .slice(0, 500)
        .map(value => value.slice(0, 200))
    : [];
  const nextCoverPaths = new Map();
  const songs = Array.isArray(nextLibrary?.songs)
    ? nextLibrary.songs.slice(0, 10000).map(song => {
        const id = typeof song?.id === 'string' ? song.id.slice(0, 1000) : '';
        const requestedCoverPath = typeof song?.coverPath === 'string'
          ? song.coverPath.slice(0, 2000)
          : '';
        let coverPath = '';
        try {
          const resolvedCoverPath = requestedCoverPath
            ? path.resolve(requestedCoverPath)
            : '';
          const coverExtension = path.extname(resolvedCoverPath).toLowerCase();
          if (
            resolvedCoverPath
            && ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(coverExtension)
          ) {
            coverPath = tabletLibraryCoverPaths.get(id) === resolvedCoverPath
              ? resolvedCoverPath
              : fs.statSync(resolvedCoverPath).isFile()
                ? resolvedCoverPath
                : '';
          }
        } catch (error) {}
        if (id && coverPath) nextCoverPaths.set(id, coverPath);
        return {
          id,
          title: typeof song?.title === 'string' ? song.title.slice(0, 300) : '',
          playlist: typeof song?.playlist === 'string' ? song.playlist.slice(0, 200) : '',
          hasCover: Boolean(coverPath),
          key: typeof song?.key === 'string' ? song.key.slice(0, 8) : '',
          bpm: song?.bpm !== null && song?.bpm !== '' && Number.isFinite(Number(song?.bpm))
            ? Number(song.bpm)
            : null,
          duration: song?.duration !== null
            && song?.duration !== ''
            && Number.isFinite(Number(song?.duration))
            ? Number(song.duration)
            : null
        };
      }).filter(song => song.id && song.title)
    : [];
  tabletLibraryCoverPaths = nextCoverPaths;
  return { type: 'library', playlists, songs };
}

function sendTabletState(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(tabletControllerState));
}

function sendTabletSession(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'session',
    sessionId: TABLET_CONTROLLER_SESSION_ID
  }));
}

function sendTabletLibrary(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(tabletControllerLibrary));
}

function broadcastTabletState() {
  if (!tabletControllerWebSocketServer) return;
  tabletControllerWebSocketServer.clients.forEach(sendTabletState);
}

function notifyTabletConnectionCount() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    'tablet-controller:connections',
    tabletControllerWebSocketServer
      ? tabletControllerWebSocketServer.clients.size
      : 0
  );
}

function forwardTabletControllerInput(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (
    tabletControllerState.libraryAnalysis?.blocking === true
    && payload.type !== 'jogEnd'
  ) {
    return;
  }
  if (payload.type === 'jogStart' || payload.type === 'jogEnd') {
    const trackNum = Number(payload.trackNum);
    if (trackNum === 1 || trackNum === 2) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: payload.type,
        trackNum
      });
    }
    return;
  }
  if (payload.type === 'jogMove' || payload.type === 'jog') {
    const trackNum = Number(payload.trackNum);
    const deltaSeconds = Number(payload.deltaSeconds);
    const elapsedMs = Number(payload.elapsedMs);
    if (
      (trackNum === 1 || trackNum === 2) &&
      Number.isFinite(deltaSeconds)
    ) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: 'jogMove',
        trackNum,
        deltaSeconds: Math.max(-1.5, Math.min(1.5, deltaSeconds)),
        elapsedMs: Number.isFinite(elapsedMs)
          ? Math.max(4, Math.min(120, elapsedMs))
          : null
      });
    }
    return;
  }
  if (payload.type === 'transport') {
    const trackNum = Number(payload.trackNum);
    const action = payload.action;
    if (
      (trackNum === 1 || trackNum === 2) &&
      (action === 'playPause' || action === 'stop')
    ) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: 'transport',
        trackNum,
        action
      });
    }
    return;
  }
  if (payload.type === 'control') {
    const trackNum = Number(payload.trackNum);
    const param = payload.param;
    const value = Number(payload.value);
    const ranges = {
      filter: [0, 100],
      echo: [0, 100],
      reverb: [0, 100],
      pan: [-100, 100],
      speed: [50, 200],
      volume: [0, 100]
    };
    const range = Object.prototype.hasOwnProperty.call(ranges, param)
      ? ranges[param]
      : null;
    if ((trackNum === 1 || trackNum === 2) && range && Number.isFinite(value)) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: 'control',
        trackNum,
        param,
        value: Math.max(range[0], Math.min(range[1], Math.round(value)))
      });
    }
    return;
  }
  if (payload.type === 'loop') {
    const trackNum = Number(payload.trackNum);
    const action = payload.action;
    const allowedActions = new Set(['in', 'out', 'auto', 'halve', 'double', 'exit']);
    if ((trackNum === 1 || trackNum === 2) && allowedActions.has(action)) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: 'loop',
        trackNum,
        action
      });
    }
    return;
  }
  if (payload.type === 'cue') {
    const trackNum = Number(payload.trackNum);
    const cueIndex = Number(payload.cueIndex);
    if (
      (trackNum === 1 || trackNum === 2) &&
      Number.isInteger(cueIndex) &&
      cueIndex >= 0 &&
      cueIndex < 8
    ) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: 'cue',
        trackNum,
        cueIndex,
        pressed: payload.pressed === true
      });
    }
    return;
  }
  if (payload.type === 'loadSong') {
    const trackNum = Number(payload.trackNum);
    const songId = typeof payload.songId === 'string'
      ? payload.songId.slice(0, 1000)
      : '';
    if ((trackNum === 1 || trackNum === 2) && songId) {
      mainWindow.webContents.send('tablet-controller:input', {
        type: 'loadSong',
        trackNum,
        songId
      });
    }
  }
}

function startTabletControllerServer() {
  if (tabletControllerServer) return Promise.resolve(getTabletControllerInfo());

  return new Promise((resolve, reject) => {
    tabletControllerServer = http.createServer(handleTabletControllerRequest);
    tabletControllerWebSocketServer = new WebSocketServer({
      server: tabletControllerServer,
      path: '/controller',
      maxPayload: 4096
    });

    tabletControllerWebSocketServer.on('connection', socket => {
      sendTabletSession(socket);
      sendTabletState(socket);
      notifyTabletConnectionCount();
      socket.on('message', rawMessage => {
        try {
          const payload = JSON.parse(rawMessage.toString());
          if (payload.type === 'requestState') {
            sendTabletState(socket);
          } else if (payload.type === 'requestLibrary') {
            sendTabletLibrary(socket);
          } else {
            forwardTabletControllerInput(payload);
          }
        } catch (error) {
          console.warn('Invalid tablet controller message:', error.message);
        }
      });
      socket.on('close', () => {
        forwardTabletControllerInput({ type: 'jogEnd', trackNum: 1 });
        forwardTabletControllerInput({ type: 'jogEnd', trackNum: 2 });
        notifyTabletConnectionCount();
      });
    });

    tabletControllerServer.once('error', error => {
      tabletControllerPort = 0;
      reject(error);
    });
    tabletControllerServer.listen(
      TABLET_CONTROLLER_PORT,
      '0.0.0.0',
      () => {
        const address = tabletControllerServer.address();
        tabletControllerPort =
          address && typeof address === 'object'
            ? address.port
            : TABLET_CONTROLLER_PORT;
        resolve(getTabletControllerInfo());
      }
    );
  });
}

function createWindow() {
  splash = new BrowserWindow({
    width: 600,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(PUBLIC_ASSETS_ROOT, 'logo.png')
  });
  splash.loadFile('splash.html', {
    query: {
      image: pathToFileURL(
        path.join(PUBLIC_ASSETS_ROOT, 'images', 'splash.png')
      ).href
    }
  });

  mainWindow = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    minWidth: 1440,
    minHeight: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false, // Keep audio running smoothly in background
      webSecurity: false
    },
    title: "notoMixer Controller",
    backgroundColor: '#0b0b0f',
    frame: true,
    icon: path.join(PUBLIC_ASSETS_ROOT, 'logo.png')
  });
  
  ipcMain.once('app-ready', () => {
    if (splash && !splash.isDestroyed()) {
      splash.destroy();
    }
    mainWindow.maximize();
    mainWindow.show();
    scheduleAutomaticUpdateCheck();
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools();
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[CONSOLE] ${message} (line ${line} in ${path.basename(sourceId)})`);
  });

  // Handle Web Serial port selection automatically based on user selection
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    
    let discoveredPorts = [...portList];
    let timeoutId = null;

    const selectAndCallback = () => {
      if (discoveredPorts.length > 0) {
        // Send the list to the renderer to display in the dropdown list
        mainWindow.webContents.send('serial-ports-list', discoveredPorts.map(p => ({
          portId: p.portId,
          portName: p.portName,
          displayName: p.displayName
        })));

        // If we have a target port name set, try to match it
        if (targetPortName) {
          const match = discoveredPorts.find(p => p.portName === targetPortName || p.portId === targetPortName);
          if (match) {
            callback(match.portId);
            cleanup();
            return true;
          }
        }
        
        // Auto-connect: default to the first available port if no target was specified
        callback(discoveredPorts[0].portId);
        cleanup();
        return true;
      }
      return false;
    };

    const onPortAdded = (e, port) => {
      if (!discoveredPorts.some(p => p.portId === port.portId)) {
        discoveredPorts.push(port);
      }
      selectAndCallback();
    };

    const cleanup = () => {
      mainWindow.webContents.session.removeListener('serial-port-added', onPortAdded);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    mainWindow.webContents.session.on('serial-port-added', onPortAdded);

    // Try immediately with already known ports
    if (selectAndCallback()) {
      return;
    }

    // Wait up to 2.5 seconds for ports to be scanned
    timeoutId = setTimeout(() => {
      callback('');
      cleanup();
    }, 2500);
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'serial' || permission === 'midi' || permission === 'media' || permission === 'audio' || permission === 'microphone') {
      return true;
    }
    return false;
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'serial' || permission === 'midi' || permission === 'media' || permission === 'audio' || permission === 'microphone') {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') {
      return true;
    }
    return false;
  });
}

// IPC listener to set the target port name before renderer calls navigator.serial.requestPort()
ipcMain.on('set-target-port', (event, portName) => {
  targetPortName = portName;
});

ipcMain.handle('tablet-controller:get-info', () => {
  return getTabletControllerInfo();
});

ipcMain.on('tablet-controller:state', (event, nextState) => {
  tabletControllerState = sanitizeTabletControllerState(nextState);
  broadcastTabletState();
});

ipcMain.on('tablet-controller:library', (event, nextLibrary) => {
  tabletControllerLibrary = sanitizeTabletControllerLibrary(nextLibrary);
});

ipcMain.handle('app-update:check', async () => {
  try {
    return await checkForAppUpdate();
  } catch (error) {
    return {
      status: error?.statusCode === 404 ? 'no-release' : 'error'
    };
  }
});

ipcMain.handle('app-update:download', async event => {
  if (!availableAppUpdate?.asset) {
    return {
      ok: false,
      error: 'No Windows installer is attached to this release.'
    };
  }
  if (updateDownloadPromise) return updateDownloadPromise;

  const sender = event.sender;
  updateDownloadPromise = appUpdater.downloadUpdate(
    availableAppUpdate,
    app.getPath('temp'),
    progress => {
      if (!sender.isDestroyed()) {
        sender.send('app-update:progress', progress);
      }
    }
  )
    .then(result => {
      downloadedUpdatePath = result.installerPath;
      return {
        ok: true,
        verified: result.verified,
        receivedBytes: result.receivedBytes
      };
    })
    .catch(error => ({
      ok: false,
      error: error?.message || 'Update download failed.'
    }))
    .finally(() => {
      updateDownloadPromise = null;
    });
  return updateDownloadPromise;
});

ipcMain.handle('app-update:install', () => {
  if (
    !downloadedUpdatePath
    || path.extname(downloadedUpdatePath).toLowerCase() !== '.exe'
    || !fs.existsSync(downloadedUpdatePath)
  ) {
    return { ok: false, error: 'The downloaded installer is no longer available.' };
  }

  return new Promise(resolve => {
    let settled = false;
    const settle = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const installer = spawn(downloadedUpdatePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      installer.once('error', () => {
        settle({ ok: false, error: 'The update installer could not be started.' });
      });
      installer.once('spawn', () => {
        installer.unref();
        settle({ ok: true });
        setTimeout(() => app.quit(), 250);
      });
    } catch (error) {
      settle({ ok: false, error: 'The update installer could not be started.' });
    }
  });
});

// IPC listener for open directory dialog (individual track loading fallback)
ipcMain.on('open-directory-dialog', (event, trackNum) => {
  dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send('directory-selected', {
        trackNum: trackNum,
        dirPath: result.filePaths[0]
      });
    }
  }).catch(err => {
    console.error(err);
  });
});

// IPC listener for choosing the working directory
ipcMain.on('select-working-directory', (event) => {
  dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select notoMixer Working Directory'
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send('working-directory-selected', result.filePaths[0]);
    }
  }).catch(err => {
    console.error(err);
  });
});


app.whenReady().then(() => {
  createWindow();
  startTabletControllerServer().catch(error => {
    console.error('Tablet controller server failed:', error);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  if (tabletControllerWebSocketServer) {
    tabletControllerWebSocketServer.close();
    tabletControllerWebSocketServer = null;
  }
  if (tabletControllerServer) {
    tabletControllerServer.close();
    tabletControllerServer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
