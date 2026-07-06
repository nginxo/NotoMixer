const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

// Disable the default application menu bar (File, Edit, View, etc.)
Menu.setApplicationMenu(null);

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let mainWindow;
let targetPortName = '';

function createWindow() {
  mainWindow = new BrowserWindow({
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
    frame: true
  });
  
  // Maximize by default for the best DJ software experience
  mainWindow.maximize();

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
    if (permission === 'serial' || permission === 'media' || permission === 'audio' || permission === 'microphone') {
      return true;
    }
    return false;
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'serial' || permission === 'media' || permission === 'audio' || permission === 'microphone') {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
