const { app, BrowserWindow, ipcMain, screen } = require('electron');

let mainWindow = null;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  mainWindow = new BrowserWindow({
    width: width,
    height: 300,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile('index.html');
  
  // 设置窗口不被屏幕捕获
  mainWindow.setContentProtection(true);
  console.log('已启用内容保护，窗口不会被录屏捕捉');
}

// IPC 通信
ipcMain.on('set-opacity', (event, opacity) => {
  if (mainWindow) {
    mainWindow.setOpacity(opacity);
  }
});

ipcMain.on('set-height', (event, height) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({ ...bounds, height: parseInt(height) });
  }
});

ipcMain.on('set-y', (event, y) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({ ...bounds, y: parseInt(y) });
  }
});

ipcMain.on('set-width', (event, width) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    const screenWidth = screen.getPrimaryDisplay().workAreaSize.width;
    const newWidth = Math.min(parseInt(width), screenWidth);
    const newX = Math.floor((screenWidth - newWidth) / 2);
    mainWindow.setBounds({ ...bounds, x: newX, width: newWidth });
  }
});

ipcMain.on('set-click-through', (event, enabled) => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
