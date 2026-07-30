const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { pathToFileURL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

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
const NOTOMIXER_ROOT = process.env.NOTOMIXER_INSTALL_ROOT
  ? path.resolve(process.env.NOTOMIXER_INSTALL_ROOT)
  : app.isPackaged
    ? path.resolve(path.dirname(process.execPath), '..')
    : __dirname;
const PUBLIC_ASSETS_ROOT = path.join(NOTOMIXER_ROOT, 'assets');
let tabletControllerServer = null;
let tabletControllerWebSocketServer = null;
let tabletControllerPort = 0;
let tabletControllerState = {
  type: 'state',
  tracks: []
};
const tabletCoverPaths = { 1: '', 2: '' };
const tabletCoverVersions = { 1: 0, 2: 0 };

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
  return { type: 'state', jogPhysics, tracks };
}

function sendTabletState(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(tabletControllerState));
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
      sendTabletState(socket);
      notifyTabletConnectionCount();
      socket.on('message', rawMessage => {
        try {
          const payload = JSON.parse(rawMessage.toString());
          if (payload.type === 'requestState') {
            sendTabletState(socket);
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
