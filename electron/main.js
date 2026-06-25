/* global MAIN_WINDOW_VITE_DEV_SERVER_URL, MAIN_WINDOW_VITE_NAME */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const log = require('electron-log');

log.info('CoffeeCare démarré');

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
  { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),  label: 'Cache Microsoft Edge' },
  { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),   label: 'Cache Google Chrome' },
  { path: path.join(localAppData, 'Mozilla', 'Firefox', 'Profiles'),                       label: 'Profils Firefox' },
  { path: path.join(localAppData, 'Discord', 'Cache'),                                     label: 'Cache Discord' },
  { path: path.join(appData, 'Spotify', 'Browser', 'Cache'),                               label: 'Cache Spotify' },
  { path: path.join(appData, 'Code', 'Cache'),                                              label: 'Cache VS Code' },
  { path: path.join(localAppData, 'Microsoft', 'Teams', 'Cache'),                          label: 'Cache Microsoft Teams' },
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
    title: 'CoffeeCare',
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

  for (const { path: dirPath, label } of TEMP_DIRS) {
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

    result.push({ path: dirPath, label, requiresAdmin, sizeBytes, fileCount });
  }

  return { ok: true, data: result };
});

ipcMain.handle('clean:deleteDirs', async (_, paths) => {
  let totalFreed = 0;
  let totalDeleted = 0;
  let totalErrors = 0;

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

  // Supprimer les dossiers non-admin directement
  for (const dirPath of normalPaths) {
    const res = await deleteContents(dirPath);
    totalFreed += res.freedBytes;
    totalDeleted += res.deletedCount;
    totalErrors += res.errorCount;
  }

  // Supprimer les dossiers admin via PowerShell élevé
  if (adminPaths.length > 0) {
    const tmpScript = path.join(os.tmpdir(), 'coffeecare_clean.ps1');
    const commands = adminPaths
      .map(p => `Get-ChildItem -Path '${p.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`)
      .join('\n');

    fs.writeFileSync(tmpScript, commands, 'utf8');

    const ps = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"' -Verb RunAs -Wait`,
    ], { timeout: 120_000 });

    if (ps.status === 0) {
      totalDeleted += adminPaths.length; // estimation
    } else {
      totalErrors += adminPaths.length;
    }

    try { fs.unlinkSync(tmpScript); } catch { /* nettoyage best-effort */ }
  }

  return { ok: totalErrors === 0, freedBytes: totalFreed, deletedCount: totalDeleted, errorCount: totalErrors };
});

// ─── Updates ───────────────────────────────────────────────────────────────

function runPsScriptElevated(scriptContent, timeoutMs = 300_000) {
  const tmpScript = path.join(os.tmpdir(), 'coffeecare_elevated.ps1');
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

ipcMain.handle('updates:installSoftware', async (_, ids) => {
  if (!ids || ids.length === 0) return { ok: true, installed: 0, errors: 0 };

  const winget = findWingetPath();
  if (!winget) return { ok: false, installed: 0, errors: ids.length };

  // Le script élevé utilise le chemin absolu vers winget.exe
  const escaped = winget.replace(/\\/g, '\\\\');
  const commands = ids
    .map(id => `& "${escaped}" upgrade --id "${id}" --silent --accept-source-agreements --accept-package-agreements --force`)
    .join('\n');

  const ps = runPsScriptElevated(commands);
  return {
    ok: ps.status === 0,
    installed: ps.status === 0 ? ids.length : 0,
    errors:    ps.status !== 0 ? ids.length : 0,
  };
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

  const lines = registryPaths
    .map(p => `Remove-Item -LiteralPath '${String(p).replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`)
    .join('\n');

  const ps = runPsScriptElevated(lines, 2 * 60_000);
  return {
    ok:     ps.status === 0,
    fixed:  ps.status === 0 ? registryPaths.length : 0,
    errors: ps.status !== 0 ? registryPaths.length : 0,
  };
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
