// electron/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
  // Liste de dossiers temporaires possiblement présents sur le système (à vérifier)
  const tempDirs = [ 
    os.tmpdir(),
    path.join(process.env.SystemRoot, 'Temp'),
    path.join(process.env.SystemRoot, 'Logs'),
    path.join(process.env.SystemRoot, 'System32', 'LogFiles'),
    path.join(process.env.SystemRoot, 'Minidump'),
    path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'WER'),
    path.join(process.env.SystemRoot, 'SoftwareDistribution', 'Download'),
    path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'INetCache'),
    path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
    path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
    path.join(process.env.LOCALAPPDATA, 'Mozilla', 'Firefox', 'Profiles'),
    path.join(process.env.LOCALAPPDATA, 'Discord', 'Cache'),
    path.join(process.env.APPDATA, 'Spotify', 'Browser', 'Cache'),
    path.join(process.env.APPDATA, 'Code', 'Cache'),
    path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Teams', 'Cache'),
  ];

  // Vérification de l'existence des dossiers
  const existingTempDirs = []; // Tableau pour stocker les dossiers existants (en tant qu'objets)
  let counter = 0;
  for( dir in tempDirs ) {
    if(fs.existsSync(tempDirs[dir])) {
      // Le dossier existe, on peut lister ses stats
      const stats = fs.statSync( tempDirs[dir] );

      if( stats.isDirectory() ) { // On s'assure que c'est bien un dossier
        // On cherche à savoir s'il faut les droits admins ou pas
        try {
          fs.accessSync( tempDirs[dir], fs.constants.X_OK | fs.constants.W_OK );
          existingTempDirs.push( {
            path: tempDirs[dir],
            requiresAdmin: false,
          } );
          counter++;
        } catch (err) {
          existingTempDirs.push( {
            path: tempDirs[dir],
            requiresAdmin: true,
          } );
        }
      }
    }
  }

  // Fonction ayant pour but de trouver des dossier cache d'application en possédant
  constCacheSoftwares = () => {
    const possibleSofwares = [
      "Discord",
      "Visual Studio Code",
      "Spotify"
    ];
  }

  return { ok: true, data: existingTempDirs, outOf15: counter };
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
