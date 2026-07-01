/* global MAIN_WINDOW_VITE_DEV_SERVER_URL, MAIN_WINDOW_VITE_NAME */
import log from 'electron-log';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

log.info('Cleaner PC started');

// Empêche plusieurs instances de tourner en même temps (évite les process
// fantômes qui verrouillent les fichiers lors d'une réinstallation/mise à jour)
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Chemins résolus une seule fois au démarrage
const sysRoot    = process.env.SystemRoot    || 'C:\\Windows';
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const appData    = process.env.APPDATA       || path.join(os.homedir(), 'AppData', 'Roaming');

const TEMP_DIRS = [
  { path: os.tmpdir(),                                                                      label: 'Fichiers temporaires utilisateur' },
  { path: path.join(sysRoot, 'Temp'),                                                       label: 'Fichiers temporaires Windows' },
  { path: path.join(sysRoot, 'Logs'),                                                       label: 'Journaux Windows' },
  { path: path.join(sysRoot, 'System32', 'LogFiles'),                                      label: 'Journaux système (System32)' },
  { path: path.join(sysRoot, 'Minidump'),                                                   label: 'Fichiers Minidump' },
  { path: path.join(localAppData, 'Microsoft', 'Windows', 'WER'),                          label: "Rapports d'erreurs Windows (WER)" },
  { path: path.join(sysRoot, 'SoftwareDistribution', 'Download'),                          label: 'Téléchargements Windows Update' },
  { path: path.join(localAppData, 'Microsoft', 'Windows', 'INetCache'),                    label: 'Cache Internet Explorer / Edge' },
  { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),  label: 'Cache Microsoft Edge',   processName: 'msedge.exe',   appName: 'Microsoft Edge' },
  { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),   label: 'Cache Google Chrome',   processName: 'chrome.exe',   appName: 'Google Chrome' },
  { path: path.join(localAppData, 'Mozilla', 'Firefox', 'Profiles'),                       label: 'Profils Firefox',        processName: 'firefox.exe',  appName: 'Firefox' },
  { path: path.join(localAppData, 'Discord', 'Cache'),                                     label: 'Cache Discord',          processName: 'Discord.exe',  appName: 'Discord' },
  { path: path.join(appData, 'Spotify', 'Browser', 'Cache'),                               label: 'Cache Spotify',          processName: 'Spotify.exe',  appName: 'Spotify' },
  { path: path.join(appData, 'Code', 'Cache'),                                              label: 'Cache VS Code',          processName: 'Code.exe',     appName: 'VS Code' },
  { path: path.join(localAppData, 'Microsoft', 'Teams', 'Cache'),                          label: 'Cache Microsoft Teams',  processName: 'ms-teams.exe', appName: 'Microsoft Teams' },
];

async function getDirInfo(dirPath) {
  let sizeBytes = 0;
  let fileCount = 0;

  async function walk(dir) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(full);
            sizeBytes += stat.size;
            fileCount++;
          } catch { /* fichier inaccessible */ }
        }
      }
    } catch { /* dossier inaccessible */ }
  }

  await walk(dirPath);
  return { sizeBytes, fileCount };
}

async function deleteContents(dirPath) {
  let freedBytes = 0;
  let deletedCount = 0;
  let errorCount = 0;

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          const stat = await fs.promises.stat(full);
          freedBytes += stat.size;
        }
        await fs.promises.rm(full, { recursive: true, force: true });
        deletedCount++;
      } catch {
        errorCount++;
      }
    }
  } catch {
    errorCount++;
  }

  return { freedBytes, deletedCount, errorCount };
}

// ─── IPC ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'Cleaner PC',
    frame: false,
    roundedCorners: false,
    backgroundColor: '#f9fafb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const win = mainWindow;

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return win;
}

ipcMain.handle('system:getInfo', () => {
  const latest = statsHistory[statsHistory.length - 1];
  return {
    osType:          os.type(),
    platform:        os.platform(),
    release:         os.release(),
    arch:            os.arch(),
    hostname:        os.hostname(),
    cpus:            os.cpus(),
    cpuUsagePercent: latest ? latest.cpuPercent : 0,
    memoryGB:        Math.round(os.totalmem() / 1024 / 1024 / 1024),
    freeMemoryGB:    latest ? latest.freeMemoryGB : parseFloat((os.freemem() / 1024 / 1024 / 1024).toFixed(1)),
    uptimeHours:     Math.round(os.uptime() / 3600),
    userInfo:        os.userInfo(),
    statsHistory:    statsHistory.slice(),
  };
});

ipcMain.handle('scan:getTempDirs', async () => {
  const result = [];
  const runningApps = [];

  // Une seule exécution de tasklist pour toutes les vérifications de processus
  let tasklistOutput = '';
  try {
    const tl = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 5000 });
    tasklistOutput = (tl.stdout || '').toLowerCase();
  } catch { /* si tasklist échoue, on continue sans détection de processus */ }

  for (const { path: dirPath, label, processName, appName } of TEMP_DIRS) {
    if (!fs.existsSync(dirPath)) continue;

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) continue;

    let requiresAdmin = false;
    try {
      fs.accessSync(dirPath, fs.constants.W_OK);
    } catch {
      requiresAdmin = true;
    }

    const { sizeBytes, fileCount } = await getDirInfo(dirPath);
    const lockedByProcess = processName && tasklistOutput.includes(processName.toLowerCase()) ? appName : undefined;

    if (lockedByProcess && !runningApps.includes(lockedByProcess)) {
      runningApps.push(lockedByProcess);
    }

    result.push({ path: dirPath, label, requiresAdmin, sizeBytes, fileCount, lockedByProcess });
  }

  return { ok: true, data: result, runningApps };
});

ipcMain.handle('clean:deleteDirs', async (_, paths) => {
  let totalFreed = 0;
  let totalDeleted = 0;
  let totalErrors = 0;
  const dirResults = [];

  // Séparer les dossiers admin et non-admin
  const adminPaths = [];
  const normalPaths = [];

  for (const dirPath of paths) {
    try {
      fs.accessSync(dirPath, fs.constants.W_OK);
      normalPaths.push(dirPath);
    } catch {
      adminPaths.push(dirPath);
    }
  }

  // Supprimer les dossiers non-admin directement ; collecter ceux totalement bloqués pour retry élevé
  const deniedForElevation = [];

  for (const dirPath of normalPaths) {
    const res = await deleteContents(dirPath);

    if (res.errorCount > 0 && res.deletedCount === 0) {
      // Aucun fichier supprimé : retry via PowerShell élevé
      deniedForElevation.push(dirPath);
    } else {
      totalFreed   += res.freedBytes;
      totalDeleted += res.deletedCount;
      totalErrors  += res.errorCount;
      const status = res.errorCount === 0 ? 'ok' : 'partial';
      dirResults.push({ path: dirPath, status, freedBytes: res.freedBytes, deletedCount: res.deletedCount, errorCount: res.errorCount });
    }
  }

  // Supprimer les dossiers admin + les dossiers complètement bloqués via PowerShell élevé
  const elevatedPaths = [...adminPaths, ...deniedForElevation];

  if (elevatedPaths.length > 0) {
    const tmpScript = path.join(os.tmpdir(), 'cleaner_pc_clean.ps1');
    const commands = elevatedPaths
      .map(p => `Get-ChildItem -Path '${p.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`)
      .join('\n');

    fs.writeFileSync(tmpScript, commands, 'utf8');

    const ps = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"' -Verb RunAs -Wait`,
    ], { timeout: 120_000 });

    for (const dirPath of elevatedPaths) {
      if (ps.status === 0) {
        totalDeleted++;
        dirResults.push({ path: dirPath, status: 'ok', freedBytes: 0, deletedCount: 1, errorCount: 0 });
      } else {
        totalErrors++;
        dirResults.push({ path: dirPath, status: 'denied', freedBytes: 0, deletedCount: 0, errorCount: 1 });
      }
    }

    try { fs.unlinkSync(tmpScript); } catch { /* nettoyage best-effort */ }
  }

  return { ok: totalErrors === 0, freedBytes: totalFreed, deletedCount: totalDeleted, errorCount: totalErrors, dirs: dirResults };
});

// ─── Updates ───────────────────────────────────────────────────────────────

function runPsScriptElevated(scriptContent, timeoutMs = 300_000) {
  const tmpScript = path.join(os.tmpdir(), 'cleaner_pc_elevated.ps1');
  fs.writeFileSync(tmpScript, scriptContent, 'utf8');
  const windowStyle = MAIN_WINDOW_VITE_DEV_SERVER_URL ? '' : ' -WindowStyle Hidden';
  const ps = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"' -Verb RunAs -Wait${windowStyle}`,
  ], { timeout: timeoutMs });
  try { fs.unlinkSync(tmpScript); } catch { /* best-effort */ }
  return ps;
}

// Localise le vrai winget.exe via Get-AppxPackage (les app execution aliases
// ne fonctionnent pas dans les sous-processus non-interactifs de Node.js)
function findWingetPath() {
  const result = spawnSync('powershell', [
    '-NoProfile', '-Command',
    '(Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue).InstallLocation',
  ], { encoding: 'utf8', timeout: 10_000 });

  const installDir = (result.stdout || '').trim();
  if (!installDir) return null;

  const candidate = path.join(installDir, 'winget.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

// Parse la sortie tableau de `winget upgrade` (colonnes à positions fixes).
// Fonctionne en français et en anglais car on utilise les positions, pas les noms.
function parseWingetTable(output) {
  // winget utilise \r seul pour le spinner de progression —
  // on sépare sur tous les retours chariot/saut de ligne
  const lines = output.split(/[\r\n]+/);

  // Ligne de séparation = au moins 20 tirets consécutifs
  const sepIdx = lines.findIndex(l => /^-{20,}/.test(l.trim()));
  if (sepIdx < 1) return [];

  const headerLine = lines[sepIdx - 1];

  // Positions de chaque colonne dans l'en-tête
  const colRegex = /\S+/g;
  const cols = [];
  let m;
  while ((m = colRegex.exec(headerLine)) !== null) {
    cols.push(m.index);
  }
  if (cols.length < 4) return [];

  const packages = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = cols.map((start, idx) => {
      const end = idx + 1 < cols.length ? cols[idx + 1] : undefined;
      return (end !== undefined ? line.slice(start, end) : line.slice(start)).trim();
    });

    const [name, id, version, available, source] = values;
    if (!id || !available) continue;

    packages.push({
      id,
      name:             name || id,
      currentVersion:   version   || 'Inconnu',
      availableVersion: available,
      source:           source    || 'winget',
    });
  }

  return packages;
}

ipcMain.handle('updates:getSoftware', async () => {
  const winget = findWingetPath();
  if (!winget) {
    return { ok: false, data: [], error: 'winget (Desktop App Installer) introuvable sur ce système.' };
  }

  // Rafraîchit le cache des sources avant de scanner pour éviter les faux positifs
  spawnSync(winget, ['source', 'update'], { encoding: 'utf8', timeout: 30_000 });

  // --output json n'est pas disponible sur toutes les versions de winget :
  // on parse la sortie tableau, universellement supportée.
  const result = spawnSync(winget, [
    'upgrade', '--include-unknown', '--accept-source-agreements',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

  if (result.error) {
    return { ok: false, data: [], error: result.error.message };
  }

  const output = result.stdout || '';
  const packages = parseWingetTable(output);
  log.info('[winget] paquets détectés:', packages.length);

  return { ok: true, data: packages };
});

const DRIVER_SCAN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  $session  = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $result   = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
  $list = @()
  foreach ($u in $result.Updates) {
    $list += [PSCustomObject]@{
      title    = $u.Title
      sizeMB   = [math]::Round($u.MaxDownloadSize / 1MB, 1)
    }
  }
  if ($list.Count -eq 0) { '[]' } else { $list | ConvertTo-Json -Depth 2 }
} catch {
  '[]'
}
`.trim();

const DRIVER_INSTALL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$session  = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result   = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
$toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $result.Updates) { $toInstall.Add($u) | Out-Null }
if ($toInstall.Count -gt 0) {
  $dl = $session.CreateUpdateDownloader()
  $dl.Updates = $toInstall
  $dl.Download()
  $inst = $session.CreateUpdateInstaller()
  $inst.Updates = $toInstall
  $inst.Install()
}
`.trim();

ipcMain.handle('updates:getDrivers', async () => {
  try {
    const tmpScript = path.join(os.tmpdir(), 'cc_driver_scan.ps1');
    fs.writeFileSync(tmpScript, DRIVER_SCAN_SCRIPT, 'utf8');
    const stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 60_000 });
    try { fs.unlinkSync(tmpScript); } catch { /* best-effort */ }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return { ok: true, data: [] };

    const parsed = JSON.parse(trimmed);
    const data = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: [], error: String(err.message || err) };
  }
});

// Codes Windows "succès + redémarrage requis" (partagés entre les deux handlers winget)
const REBOOT_CODES = new Set([3010, 1641]);

// Retire les lignes de spinner de progression winget (-, \, |, /) et les lignes vides
function cleanWingetOutput(output) {
  return output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^[-\\|/]$/.test(l));
}

const WINGET_REASON_PATTERNS = [
  [/fichiers.{0,80}actuellement utilis/i,                   "Fermez l'application, puis réessayez"],
  [/technologie d.installation différente/i,                'Réinstallation manuelle requise'],
  [/code de hachage.{0,40}ne correspond pas/i,              'Problème de téléchargement — réessayez'],
  [/aucune mise à (?:niveau|upgrade) applicable/i,          'Pas de version compatible pour votre système'],
  [/ne s.applique pas à votre système/i,                    'Pas de version compatible pour votre système'],
  [/aucun package installé ne correspond/i,                 'Package non reconnu par winget'],
  [/impossible de déterminer le numéro de version/i,        'Version non identifiable — mise à jour impossible'],
  [/application not found/i,                                'Application introuvable par winget'],
  [/une erreur inattendue s.est produite/i,                 'Erreur interne — réessayez'],
  [/code de sortie.*3221226525/,                            'Droits administrateur probablement requis'],
  [/code de sortie.*6\b/,                                   "Fermez l'application avant de mettre à jour"],
];

function extractWingetReason(output, exitCode) {
  for (const [pattern, message] of WINGET_REASON_PATTERNS) {
    if (pattern.test(output)) return message;
  }

  // Dernière ligne significative (ignore les lignes de spinner : -, \, |, /)
  const lastLine = output.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 5 && !/^[-\\|/]$/.test(l))
    .pop();

  if (lastLine) return lastLine.slice(0, 120);

  const CODE_MAP = {
    2316632070: "L'installeur a échoué",
    2316632337: "Fichiers en cours d'utilisation — fermez l'application",
    2316632081: 'Vérification de sécurité échouée',
    2147746293: 'Application introuvable par winget',
  };
  return CODE_MAP[exitCode] || `Code d'erreur ${exitCode}`;
}

ipcMain.handle('updates:installSoftwareStream', async (event, packages) => {
  if (!packages || packages.length === 0) return { logFile: null };

  const winget   = findWingetPath();
  const logsDir  = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const logFile   = path.join(logsDir, `update-${timestamp}.log`);
  const logLines  = [
    `=== Rapport de mise à jour — ${new Date().toLocaleString('fr-FR')} ===`,
    `winget : ${winget ?? 'introuvable'}`,
    '',
  ];
  let hasErrors = false;

  for (const { id, name } of packages) {
    event.sender.send('updates:swProgress', { id, status: 'installing' });

    if (!winget) {
      logLines.push(`✗ ${name} (${id})\n  winget introuvable\n`);
      hasErrors = true;
      event.sender.send('updates:swProgress', { id, status: 'error' });
      continue;
    }

    // Script PowerShell par package : capture stdout+stderr via 2>&1,
    // préserve le code de sortie de winget
    const scriptFile = path.join(os.tmpdir(), `cc_install_${Date.now()}.ps1`);
    const ew = winget.replace(/'/g, "''");
    const ei = id.replace(/'/g, "''");
    const script = [
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `$out = & '${ew}' upgrade --id '${ei}' --include-unknown --silent --accept-source-agreements --accept-package-agreements --force --disable-interactivity 2>&1`,
      `$code = $LASTEXITCODE`,
      `$out | ForEach-Object { Write-Output $_ }`,
      `exit $code`,
    ].join('\n');
    fs.writeFileSync(scriptFile, script, 'utf8');

    let ok = false;
    let captured = '';
    let exitCode = -1;

    try {
      const result = await execFileAsync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
      ], { timeout: 300_000, encoding: 'utf8' });
      captured = ((result.stdout || '') + (result.stderr || '')).trim();
      ok = true;
      exitCode = 0;
    } catch (err) {
      captured = ((err.stdout || '') + (err.stderr || '')).trim();
      exitCode = typeof err.code === 'number' ? err.code : -1;
      // Ces codes signifient "installé avec succès, mais redémarrage nécessaire"
      if (REBOOT_CODES.has(exitCode)) ok = true;
    }

    try { fs.unlinkSync(scriptFile); } catch { /* best-effort */ }

    // Détection du type de redémarrage requis
    let reboot = undefined;
    if (ok) {
      if (REBOOT_CODES.has(exitCode)) {
        reboot = 'system';
      } else if (/redémarr[a-z]*\s.{0,40}(?:application|logiciel)|restart\s.{0,40}application/i.test(captured)) {
        reboot = 'app';
      } else if (/redémarr[a-z]*\s.{0,40}(?:ordinateur|système|pc|windows)|reboot\s.{0,40}(?:required|computer|machine)/i.test(captured)) {
        reboot = 'system';
      }
    }

    log[ok ? 'info' : 'warn'](`[winget] ${ok ? 'OK' : 'FAIL'} ${id} (exit=${exitCode})\n${captured}`);

    if (ok) {
      const rebootNote = reboot === 'system' ? ' (redémarrage PC requis)'
                       : reboot === 'app'    ? ' (redémarrage logiciel requis)'
                       : '';
      logLines.push(`✓ ${name} (${id}) — Mis à jour${rebootNote}`);
    } else {
      hasErrors = true;
      const cleaned = cleanWingetOutput(captured);
      const outputSection = cleaned.length > 0
        ? cleaned.map(l => `  ${l}`).join('\n')
        : '  (aucune sortie capturée — winget écrit peut-être directement sur la console)';
      logLines.push(`✗ ${name} (${id}) — Échec (code de sortie : ${exitCode})\n${outputSection}`);
    }

    const reason = ok ? undefined : extractWingetReason(captured, exitCode);
    event.sender.send('updates:swProgress', { id, status: ok ? 'ok' : 'error', reason, reboot });
  }

  if (hasErrors) {
    fs.writeFileSync(logFile, logLines.join('\n'), 'utf8');
    log.info(`[winget] rapport écrit : ${logFile}`);
    return { logFile };
  }

  return { logFile: null };
});

ipcMain.handle('shell:openPath', (_, filePath) => shell.openPath(filePath));

ipcMain.handle('updates:installElevated', async (_, { id, name }) => {
  const winget = findWingetPath();
  if (!winget) return { ok: false, reason: 'winget introuvable' };

  const ts          = Date.now();
  const innerScript = path.join(os.tmpdir(), `cc_elev_inner_${ts}.ps1`);
  const wrapScript  = path.join(os.tmpdir(), `cc_elev_wrap_${ts}.ps1`);
  const outFile     = path.join(os.tmpdir(), `cc_elev_out_${ts}.txt`);
  const codeFile    = path.join(os.tmpdir(), `cc_elev_code_${ts}.txt`);

  const ew = winget.replace(/'/g, "''");
  const ei = id.replace(/'/g, "''");
  const qInner = innerScript.replace(/'/g, "''");
  const qOut   = outFile.replace(/'/g, "''");
  const qCode  = codeFile.replace(/'/g, "''");

  // Script élevé : exécute winget et écrit la sortie + code dans des fichiers temp
  // [Console]::OutputEncoding évite le mojibake (winget écrit en UTF-8, la console
  // l'interprète par défaut avec le codepage OEM du système)
  fs.writeFileSync(innerScript, [
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$out  = & '${ew}' upgrade --id '${ei}' --include-unknown --silent --accept-source-agreements --accept-package-agreements --force --disable-interactivity 2>&1`,
    `$code = $LASTEXITCODE`,
    `$out  | Out-File '${qOut}'  -Encoding UTF8`,
    `$code | Out-File '${qCode}' -Encoding UTF8`,
  ].join('\n'), 'utf8');

  // Script wrapper : lance le script élevé via UAC sans fenêtre visible
  // Forme tableau pour -ArgumentList → gère les chemins avec espaces
  fs.writeFileSync(wrapScript, [
    `$inner = '${qInner}'`,
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $inner)`,
  ].join('\n'), 'utf8');

  let captured = '';
  let exitCode = -1;

  try {
    // execFileAsync est async → n'bloque pas l'event loop pendant l'UAC
    await execFileAsync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapScript,
    ], { timeout: 600_000 });
  } catch (err) {
    log.warn(`[winget-elevated] wrapper erreur: ${err.message}`);
    for (const f of [wrapScript, innerScript, outFile, codeFile]) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
    return { ok: false, reason: 'Autorisation refusée ou mise à jour annulée' };
  }

  for (const f of [wrapScript, innerScript]) {
    try { fs.unlinkSync(f); } catch { /* best-effort */ }
  }

  try {
    if (fs.existsSync(outFile))  { captured = fs.readFileSync(outFile, 'utf8').trim();  fs.unlinkSync(outFile); }
    if (fs.existsSync(codeFile)) { exitCode = parseInt(fs.readFileSync(codeFile, 'utf8').trim(), 10) || -1; fs.unlinkSync(codeFile); }
  } catch (e) {
    log.warn(`[winget-elevated] lecture résultats: ${e.message}`);
  }

  const ok = exitCode === 0 || REBOOT_CODES.has(exitCode);
  const reboot = ok
    ? (REBOOT_CODES.has(exitCode) ? 'system'
      : /redémarr[a-z]*\s.{0,40}(?:application|logiciel)/i.test(captured) ? 'app'
      : /redémarr[a-z]*\s.{0,40}(?:ordinateur|système|pc|windows)/i.test(captured) ? 'system'
      : undefined)
    : undefined;

  log[ok ? 'info' : 'warn'](`[winget-elevated] ${ok ? 'OK' : 'FAIL'} ${id} (exit=${exitCode})\n${captured}`);

  if (!ok) {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const logFile = path.join(logsDir, `update-${timestamp}.log`);
    const cleaned = cleanWingetOutput(captured);
    const lines = [
      `=== Rapport de mise à jour — ${new Date().toLocaleString('fr-FR')} ===`,
      '',
      `✗ ${name} (${id}) — Échec admin (code de sortie : ${exitCode})`,
      ...(cleaned.length > 0 ? cleaned.map(l => `  ${l}`) : ['  (aucune sortie capturée)']),
    ];
    fs.writeFileSync(logFile, lines.join('\n'), 'utf8');

    // On a déjà élevé les droits ici : si le diagnostic générique pointe encore
    // vers un problème de droits, c'est forcément autre chose (l'installeur a planté,
    // souvent parce que l'application visée est encore ouverte).
    let reason = extractWingetReason(captured, exitCode);
    if (reason === 'Droits administrateur probablement requis') {
      reason = `Le programme d'installation a planté — fermez complètement ${name} (icône dans la barre des tâches incluse), puis réessayez`;
    }

    return { ok: false, reason, logFile };
  }

  return { ok: true, reason: undefined, reboot };
});

// Mots trop génériques pour servir de signal de correspondance (vendor/suffixes courants)
const APP_NAME_FILLER_WORDS = new Set([
  'software', 'application', 'app', 'setup', 'installer', 'update', 'desktop',
  'client', 'for', 'windows', 'edition', 'inc', 'corp', 'corporation', 'ltd',
  'llc', 'gmbh', '64-bit', '32-bit', 'x64', 'x86',
  'studio', // trop générique : "Visual Studio Code", "Android Studio", etc.
]);

// Recherche heuristique : aucune correspondance fiable entre un id winget et un
// processus en cours, donc on compare les mots significatifs du nom de paquet
// à la description/produit des exécutables actifs (FileVersionInfo).
ipcMain.handle('updates:closeRelatedApp', async (_, { name }) => {
  const words = (name.match(/[a-zA-Z0-9]+/g) || [])
    .filter(w => w.length >= 3 && !APP_NAME_FILLER_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return { ok: false, reason: 'not_found' };

  const wordsArg = words.map(w => `'${w.replace(/'/g, "''")}'`).join(',');
  const script = [
    `$words = @(${wordsArg}) | ForEach-Object { $_.ToLower() }`,
    `$candidates = @()`,
    `foreach ($p in (Get-Process | Where-Object { $_.Id -ne $PID })) {`,
    `  try { $fvi = $p.MainModule.FileVersionInfo } catch { continue }`,
    `  $hay = ("$($fvi.FileDescription) $($fvi.ProductName) $($p.ProcessName)").ToLower()`,
    `  foreach ($w in $words) { if ($hay.Contains($w)) { $candidates += $p; break } }`,
    `}`,
    `$distinct = $candidates | Select-Object -ExpandProperty ProcessName -Unique`,
    `if ($distinct.Count -eq 0) {`,
    `  Write-Output 'NONE'`,
    `} elseif ($distinct.Count -gt 1) {`,
    `  Write-Output ('AMBIGUOUS:' + ($distinct -join ','))`,
    `} else {`,
    `  $candidates | Stop-Process -Force -ErrorAction SilentlyContinue`,
    `  Write-Output ('KILLED:' + $distinct[0])`,
    `}`,
  ].join('\n');

  const tmpScript = path.join(os.tmpdir(), `cc_closeapp_${Date.now()}.ps1`);
  fs.writeFileSync(tmpScript, script, 'utf8');

  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 15_000 }).trim();

    if (out.startsWith('KILLED:'))     return { ok: true, processName: out.slice(7) };
    if (out.startsWith('AMBIGUOUS:'))  return { ok: false, reason: 'ambiguous', candidates: out.slice(10).split(',') };
    return { ok: false, reason: 'not_found' };
  } catch (err) {
    log.warn(`[closeRelatedApp] erreur: ${err.message}`);
    return { ok: false, reason: 'error' };
  } finally {
    try { fs.unlinkSync(tmpScript); } catch { /* best-effort */ }
  }
});

ipcMain.handle('updates:installDrivers', async () => {
  const ps = runPsScriptElevated(DRIVER_INSTALL_SCRIPT);
  return { ok: ps.status === 0, installed: ps.status === 0 ? 1 : 0, errors: ps.status !== 0 ? 1 : 0 };
});

// ─── Repair — Services ─────────────────────────────────────────────────────

const CRITICAL_SERVICES = [
  { name: 'wuauserv',  label: 'Windows Update',              description: 'Téléchargement des mises à jour Windows',     expectedStart: 'Automatic' },
  { name: 'WinDefend', label: 'Windows Defender Antivirus',  description: 'Protection antivirus en temps réel',           expectedStart: 'Automatic' },
  { name: 'wscsvc',    label: 'Centre de sécurité Windows',  description: 'Surveillance de la sécurité système',          expectedStart: 'Automatic' },
  { name: 'MpsSvc',    label: 'Pare-feu Windows',            description: 'Protection du trafic réseau',                  expectedStart: 'Automatic' },
  { name: 'BITS',      label: 'BITS',                        description: 'Transfert de données en arrière-plan',         expectedStart: 'Manual'    },
  { name: 'cryptsvc',  label: 'Services de chiffrement',     description: 'Requis pour Windows Update et la sécurité',   expectedStart: 'Automatic' },
  { name: 'EventLog',  label: "Journal d'événements Windows", description: 'Enregistrement des événements système',       expectedStart: 'Automatic' },
  { name: 'RpcSs',     label: 'Appel de procédure distante', description: 'Service fondamental du système Windows',       expectedStart: 'Automatic' },
  { name: 'AudioSrv',  label: 'Audio Windows',               description: 'Gestion des périphériques audio',              expectedStart: 'Automatic' },
  { name: 'Dnscache',  label: 'Client DNS',                  description: 'Résolution des noms de domaine',               expectedStart: 'Automatic' },
  { name: 'Spooler',   label: "Spouleur d'impression",        description: 'Gestion de la file d\'impression',            expectedStart: 'Automatic' },
  { name: 'WSearch',   label: 'Recherche Windows',           description: 'Indexation pour la recherche dans l\'Explorer', expectedStart: 'Automatic' },
];

const SERVICE_SCAN_SCRIPT = (() => {
  const names = CRITICAL_SERVICES.map(s => `'${s.name}'`).join(',');
  return `
$names = @(${names})
$result = @($names | ForEach-Object {
  $svc = Get-Service -Name $_ -ErrorAction SilentlyContinue
  if ($svc) {
    [PSCustomObject]@{
      name      = $svc.Name
      status    = $svc.Status.ToString()
      startType = $svc.StartType.ToString()
    }
  }
})
if ($result.Count -eq 0) { '[]' } else { $result | ConvertTo-Json -Depth 2 }
`.trim();
})();

ipcMain.handle('repair:getServices', async () => {
  try {
    const tmpScript = path.join(os.tmpdir(), 'cc_svc_scan.ps1');
    fs.writeFileSync(tmpScript, SERVICE_SCAN_SCRIPT, 'utf8');
    const stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 20_000 });
    try { fs.unlinkSync(tmpScript); } catch { /* best-effort */ }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return { ok: true, data: [] };

    const raw = JSON.parse(trimmed);
    const rows = Array.isArray(raw) ? raw : [raw];

    const data = CRITICAL_SERVICES.map(def => {
      const found = rows.find(r => r.name.toLowerCase() === def.name.toLowerCase());
      const status    = found?.status    || 'Unknown';
      const startType = found?.startType || 'Unknown';

      const hasIssue =
        (def.expectedStart === 'Automatic' && (status === 'Stopped' || status === 'Disabled' || startType === 'Disabled')) ||
        (def.expectedStart === 'Manual'    && startType === 'Disabled');

      return {
        name:        def.name,
        label:       def.label,
        description: def.description,
        status,
        startType,
        hasIssue,
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: [], error: err.message };
  }
});

ipcMain.handle('repair:fixServices', async (_, names) => {
  if (!names || names.length === 0) return { ok: true, fixed: 0, errors: 0 };

  const commands = names.map(name => `
$svc = Get-Service -Name '${name}' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.StartType -eq 'Disabled') {
    Set-Service -Name '${name}' -StartupType Automatic -ErrorAction SilentlyContinue
  }
  Start-Service -Name '${name}' -ErrorAction SilentlyContinue
}
`.trim()).join('\n\n');

  const ps = runPsScriptElevated(commands);
  return {
    ok:     ps.status === 0,
    fixed:  ps.status === 0 ? names.length : 0,
    errors: ps.status !== 0 ? names.length : 0,
  };
});

// ─── Repair — Fichiers système (SFC) ───────────────────────────────────────

function parseSFCOutput(output) {
  if (!output || !output.trim()) return 'unknown';
  // CBS.log [SR] lines (toujours en anglais)
  if (/did not find any integrity violation/i.test(output)) return 'healthy';
  if (/found corrupt files and successfully repaired/i.test(output)) return 'repaired';
  if (/found corrupt files but was unable to fix/i.test(output)) return 'failed';
  return 'unknown';
}

ipcMain.handle('repair:runSFC', async () => {
  const resultFile = path.join(os.tmpdir(), `cc_sfc_${Date.now()}.txt`);
  const safeResult = resultFile.replace(/'/g, "''");

  // SFC écrit dans le buffer console (pas stdout) — impossible à capturer via pipe.
  // On le lance normalement, puis on lit le CBS.log que Windows écrit systématiquement.
  const script = `
& sfc /scannow
$log = "$env:SystemRoot\\Logs\\CBS\\CBS.log"
if (Test-Path $log) {
    Get-Content -LiteralPath $log -Tail 100 -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '\\[SR\\]' } |
        Out-File -LiteralPath '${safeResult}' -Encoding UTF8 -Force
} else {
    'CBS log not found' | Out-File -LiteralPath '${safeResult}' -Encoding UTF8 -Force
}
`.trim();

  const ps = runPsScriptElevated(script, 25 * 60_000);

  let sfcOutput = '';
  try {
    sfcOutput = fs.readFileSync(resultFile, 'utf8');
    fs.unlinkSync(resultFile);
  } catch { /* utilisateur a annulé l'UAC */ }

  return {
    ok:     ps.status === 0,
    status: parseSFCOutput(sfcOutput),
    excerpt: sfcOutput
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .slice(-10)
      .join('\n'),
  };
});

// ─── Repair — Périphériques (Device Manager) ───────────────────────────────

const DRIVER_SCAN_SCRIPT_PNPDEVICE = `
$devices = @(Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.Status -notin @('OK', 'Unknown') } |
  Select-Object Name, InstanceId, Status, Class)
if ($devices.Count -eq 0) { '[]' } else { $devices | ConvertTo-Json -Depth 2 }
`.trim();

ipcMain.handle('repair:getDriverErrors', async () => {
  try {
    const tmpScript = path.join(os.tmpdir(), 'cc_drv_scan.ps1');
    fs.writeFileSync(tmpScript, DRIVER_SCAN_SCRIPT_PNPDEVICE, 'utf8');
    const stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 30_000 });
    try { fs.unlinkSync(tmpScript); } catch { /* noop */ }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return { ok: true, data: [] };

    const raw = JSON.parse(trimmed);
    const rows = Array.isArray(raw) ? raw : [raw];

    const data = rows.map(r => ({
      name:       r.Name       || 'Périphérique inconnu',
      instanceId: r.InstanceId || '',
      status:     r.Status     || 'Unknown',
      deviceClass: r.Class     || '',
    }));

    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: [], error: err.message };
  }
});

ipcMain.handle('repair:fixDriverErrors', async (_, instanceIds) => {
  if (!instanceIds || instanceIds.length === 0) return { ok: true, fixed: 0, errors: 0 };

  const ids = instanceIds
    .map(id => `'${String(id).replace(/'/g, "''")}'`)
    .join(',\n  ');

  const script = `
$ids = @(
  ${ids}
)
$errors = 0
foreach ($id in $ids) {
  try {
    Disable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
    Start-Sleep -Milliseconds 500
    Enable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
  } catch {
    $errors++
  }
}
`.trim();

  const ps = runPsScriptElevated(script, 5 * 60_000);
  return {
    ok:     ps.status === 0,
    fixed:  ps.status === 0 ? instanceIds.length : 0,
    errors: ps.status !== 0 ? instanceIds.length : 0,
  };
});

// ─── Repair — Registre ─────────────────────────────────────────────────────

const REGISTRY_SCAN_SCRIPT = `
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)

$orphaned = @($paths | ForEach-Object {
  Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue
} | Where-Object {
  $name = $_.DisplayName
  $loc  = $_.InstallLocation
  $sys  = $_.SystemComponent
  if (-not $name -or -not $loc -or $sys -eq 1) { return $false }
  $loc = $loc.Trim()
  if ($loc.Length -lt 4) { return $false }
  $loc = [Environment]::ExpandEnvironmentVariables($loc)
  -not (Test-Path $loc)
} | Select-Object DisplayName, InstallLocation, PSPath)

if ($orphaned.Count -eq 0) { '[]' } else { $orphaned | ConvertTo-Json -Depth 2 }
`.trim();

ipcMain.handle('repair:getRegistryIssues', async () => {
  try {
    const tmpScript = path.join(os.tmpdir(), 'cc_reg_scan.ps1');
    fs.writeFileSync(tmpScript, REGISTRY_SCAN_SCRIPT, 'utf8');
    const stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 30_000 });
    try { fs.unlinkSync(tmpScript); } catch { /* noop */ }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return { ok: true, data: [] };

    const raw = JSON.parse(trimmed);
    const rows = Array.isArray(raw) ? raw : [raw];

    const data = rows.map(r => ({
      name:            r.DisplayName     || 'Programme inconnu',
      installLocation: r.InstallLocation || '',
      registryPath:    r.PSPath          || '',
    }));

    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: [], error: err.message };
  }
});

ipcMain.handle('repair:fixRegistryIssues', async (_, registryPaths) => {
  if (!registryPaths || registryPaths.length === 0) return { ok: true, fixed: 0, errors: 0 };

  // PSPath (ex: "Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE\...") n'est pas
  // utilisable tel quel par Remove-Item dans une session élevée distincte — on le convertit
  // en chemin PSDrive standard (HKLM:\..., HKCU:\...) que PowerShell reconnaît toujours.
  const regPaths = registryPaths.map(p =>
    String(p)
      .replace(/^Microsoft\.PowerShell\.Core\\Registry::HKEY_LOCAL_MACHINE/i, 'HKLM:')
      .replace(/^Microsoft\.PowerShell\.Core\\Registry::HKEY_CURRENT_USER/i,  'HKCU:')
      .replace(/^Microsoft\.PowerShell\.Core\\Registry::HKEY_CLASSES_ROOT/i,  'HKCR:')
      .replace(/^Microsoft\.PowerShell\.Core\\Registry::HKEY_USERS/i,         'HKU:')
  );

  const resultFile = path.join(os.tmpdir(), `cc_reg_fix_${Date.now()}.txt`);
  const safeResult = resultFile.replace(/'/g, "''");

  const deletions = regPaths
    .map(p => {
      const safe = p.replace(/'/g, "''");
      return `if (Test-Path -LiteralPath '${safe}') { try { Remove-Item -LiteralPath '${safe}' -Recurse -Force -ErrorAction Stop; $fixed++ } catch { $errors++ } } else { $errors++ }`;
    })
    .join('\n');

  const script = `$fixed = 0\n$errors = 0\n${deletions}\n"$fixed|$errors" | Out-File -LiteralPath '${safeResult}' -Encoding UTF8 -Force`;

  runPsScriptElevated(script, 2 * 60_000);

  let fixed = 0;
  let errors = registryPaths.length;
  try {
    const content = fs.readFileSync(resultFile, 'utf8').trim();
    fs.unlinkSync(resultFile);
    const parts = content.split('|').map(Number);
    fixed  = parts[0] || 0;
    errors = parts[1] || 0;
  } catch { /* UAC annulé — errors reste à registryPaths.length */ }

  return { ok: errors === 0, fixed, errors };
});

// ─── Repair — Démarrage ────────────────────────────────────────────────────

const STARTUP_SCAN_SCRIPT = `
$skip = @('PSPath','PSParentPath','PSChildName','PSProvider','PSDrive')
$result = @()

# Entrées utilisateur (HKCU)
$runHkcu      = Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
$approvedHkcu = Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -ErrorAction SilentlyContinue
if ($runHkcu) {
  foreach ($p in ($runHkcu.PSObject.Properties | Where-Object { $_.Name -notin $skip })) {
    $enabled = $true
    if ($approvedHkcu) {
      $v = $approvedHkcu.PSObject.Properties[$p.Name]
      if ($v -and $v.Value -is [byte[]] -and $v.Value.Length -gt 0) { $enabled = $v.Value[0] -ne 3 }
    }
    $result += [PSCustomObject]@{ name = $p.Name; command = $p.Value; enabled = $enabled; source = 'user' }
  }
}

# Entrées système (HKLM)
$runHklm      = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
$approvedHklm = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -ErrorAction SilentlyContinue
if ($runHklm) {
  foreach ($p in ($runHklm.PSObject.Properties | Where-Object { $_.Name -notin $skip })) {
    $enabled = $true
    if ($approvedHklm) {
      $v = $approvedHklm.PSObject.Properties[$p.Name]
      if ($v -and $v.Value -is [byte[]] -and $v.Value.Length -gt 0) { $enabled = $v.Value[0] -ne 3 }
    }
    $result += [PSCustomObject]@{ name = $p.Name; command = $p.Value; enabled = $enabled; source = 'system' }
  }
}

if ($result.Count -eq 0) { '[]' } else { $result | ConvertTo-Json -Depth 2 }
`.trim();

ipcMain.handle('repair:getStartupItems', async () => {
  try {
    const tmpScript = path.join(os.tmpdir(), 'cc_startup_scan.ps1');
    fs.writeFileSync(tmpScript, STARTUP_SCAN_SCRIPT, 'utf8');
    const stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 20_000 });
    try { fs.unlinkSync(tmpScript); } catch { /* noop */ }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return { ok: true, data: [] };

    const raw = JSON.parse(trimmed);
    const rows = Array.isArray(raw) ? raw : [raw];

    return {
      ok: true,
      data: rows.map(r => ({
        name:    r.name    || '',
        command: r.command || '',
        enabled: r.enabled === true || r.enabled === 'True',
        source:  r.source  === 'system' ? 'system' : 'user',
      })),
    };
  } catch (err) {
    return { ok: false, data: [], error: err.message };
  }
});

// changes: Array<{ name, source: 'user'|'system', enabled }>
ipcMain.handle('repair:setStartupItems', async (_, changes) => {
  if (!changes || changes.length === 0) return { ok: true };

  const lines = changes.map(({ name, source, enabled }) => {
    const safeName = String(name).replace(/'/g, "''");
    const keyPath  = source === 'system'
      ? 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
      : 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
    const firstByte = enabled ? 2 : 3;
    return `
$p = '${keyPath}'
if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
$d = [byte[]](${firstByte},0,0,0,0,0,0,0,0,0,0,0)
Set-ItemProperty -Path $p -Name '${safeName}' -Value $d -Type Binary -ErrorAction SilentlyContinue`.trim();
  }).join('\n\n');

  const ps = runPsScriptElevated(lines, 30_000);
  return { ok: ps.status === 0 };
});

// ─── Repair — Disque ───────────────────────────────────────────────────────

const DISK_SCAN_SCRIPT = `
$result = @(Get-Disk -ErrorAction SilentlyContinue | ForEach-Object {
  $disk = $_
  $vols = @($disk |
    Get-Partition -ErrorAction SilentlyContinue |
    Where-Object { $_.DriveLetter } |
    ForEach-Object {
      $vol = $_ | Get-Volume -ErrorAction SilentlyContinue
      if ($vol) {
        [PSCustomObject]@{
          letter       = $_.DriveLetter.ToString()
          label        = if ($vol.FileSystemLabel) { $vol.FileSystemLabel } else { "Disque $($_.DriveLetter)" }
          sizeGB       = [Math]::Round($vol.Size / 1GB, 1)
          freeGB       = [Math]::Round($vol.SizeRemaining / 1GB, 1)
          healthStatus = $vol.HealthStatus.ToString()
        }
      }
    })
  [PSCustomObject]@{
    name         = $disk.FriendlyName
    healthStatus = $disk.HealthStatus.ToString()
    sizeGB       = [Math]::Round($disk.Size / 1GB, 1)
    volumes      = $vols
  }
})
if ($result.Count -eq 0) { '[]' } else { $result | ConvertTo-Json -Depth 4 }
`.trim();

ipcMain.handle('repair:getDiskHealth', async () => {
  try {
    const tmpScript = path.join(os.tmpdir(), 'cc_disk_scan.ps1');
    fs.writeFileSync(tmpScript, DISK_SCAN_SCRIPT, 'utf8');
    const stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript,
    ], { encoding: 'utf8', timeout: 20_000 });
    try { fs.unlinkSync(tmpScript); } catch { /* noop */ }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return { ok: true, disks: [] };
    const raw = JSON.parse(trimmed);
    const rows = Array.isArray(raw) ? raw : [raw];

    return {
      ok: true,
      disks: rows.map(d => ({
        name:         d.name         || 'Disque inconnu',
        healthStatus: d.healthStatus || 'Unknown',
        sizeGB:       d.sizeGB       || 0,
        volumes: (Array.isArray(d.volumes) ? d.volumes : d.volumes ? [d.volumes] : []).map(v => ({
          letter:       v.letter       || '',
          label:        v.label        || `Disque ${v.letter}`,
          sizeGB:       v.sizeGB       || 0,
          freeGB:       v.freeGB       || 0,
          healthStatus: v.healthStatus || 'Unknown',
        })),
      })),
    };
  } catch (err) {
    return { ok: false, disks: [], error: err.message };
  }
});

// letters: string[] — ex: ['C', 'D']
ipcMain.handle('repair:scheduleDiskCheck', async (_, letters) => {
  if (!letters || letters.length === 0) return { ok: true };

  const lines = letters
    .map(l => `chkntfs /c ${String(l).replace(/[^A-Za-z]/g, '')}:`)
    .join('\n');

  const ps = runPsScriptElevated(lines, 30_000);
  return { ok: ps.status === 0 };
});

// ─── Paramètres ─────────────────────────────────────────────────────────────

ipcMain.handle('settings:getInfo', () => ({
  version:     app.getVersion(),
  openAtLogin: app.getLoginItemSettings().openAtLogin,
}));

ipcMain.handle('settings:setLoginItem', (_, openAtLogin) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(openAtLogin) });
  return { ok: true };
});

// ─── Window controls ────────────────────────────────────────────────────────

ipcMain.handle('window:minimize',    () => mainWindow?.minimize());
ipcMain.handle('window:maximize',    () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.handle('window:close',       () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

// ─── Stats background sampler ───────────────────────────────────────────────

const statsHistory = [];
let lastCpuSnapshot = null;

function sampleStats() {
  const cpus = os.cpus();
  if (lastCpuSnapshot) {
    let idleTotal = 0, allTotal = 0;
    for (let i = 0; i < lastCpuSnapshot.length; i++) {
      const b = lastCpuSnapshot[i].times;
      const a = cpus[i].times;
      idleTotal += a.idle - b.idle;
      allTotal  += (a.user + a.nice + a.sys + a.idle + a.irq)
                 - (b.user + b.nice + b.sys + b.idle + b.irq);
    }
    statsHistory.push({
      timestamp:   Date.now(),
      cpuPercent:  allTotal > 0 ? Math.round((1 - idleTotal / allTotal) * 100) : 0,
      freeMemoryGB: parseFloat((os.freemem() / 1024 / 1024 / 1024).toFixed(1)),
    });
    if (statsHistory.length > 20) statsHistory.shift();
  }
  lastCpuSnapshot = cpus;
}

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  sampleStats();
  setInterval(sampleStats, 3000);
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
