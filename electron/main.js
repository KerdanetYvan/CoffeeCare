// electron/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

// Création d'un système simple de log :
const log = require('electron-log');

/// Exemple : log vers la console + fichier
log.info('CoffeeCare démarré');
log.warn('Attention : test de log');
log.error('Erreur simulée');
// Système de log créé

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'CoffeeCare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(process.cwd(), 'dist', 'index.html'));
  }

  return win;
}

// Exemple d'API IPC : obtenir des infos système
ipcMain.handle('system:getInfo', async () => {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    hostname: os.hostname(),
  };
});

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
