// electron/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

// Création d'un système simple de log :
const log = require('electron-log');
const { uptime } = require('process');

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
    osType: os.type(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus(),
    memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    uptimeHours: Math.round(os.uptime() / 3600),
    userInfo: os.userInfo(),
  };
});

// Gestion de la détection des dossiers de fichier temporaire
ipcMain.handle('scan:getTempDirs', async () => {
  const tempDirs = [ os.tmpdir(), path.resolve('C:\\Windows\\Temp') ];
  return { ok: true, data: tempDirs };
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
