//! Réparation : services, fichiers système, périphériques, registre, démarrage, disques.
//!
//! Chaque lecture s'exécute dans un PowerShell normal ; chaque correction passe par
//! un PowerShell administrateur. Les valeurs venant de l'interface sont validées
//! (liste fermée de services, clés de registre de la liste des programmes, lettres
//! de disque) puis échappées avant d'être insérées dans un script.

use crate::ps;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const SCAN_TIMEOUT: Duration = Duration::from_secs(20);
const LONG_SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const FIX_TIMEOUT: Duration = Duration::from_secs(300);
const SFC_TIMEOUT: Duration = Duration::from_secs(25 * 60);
const DRIVER_FIX_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const REGISTRY_FIX_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const SMALL_FIX_TIMEOUT: Duration = Duration::from_secs(30);

/// Message affiché quand une analyse échoue : pas de détail technique pour l'utilisateur.
const SCAN_ERROR: &str = "Une erreur est survenue, réessayez";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn text_or(v: &Value, key: &str, default: &str) -> String {
    match v.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => default.to_string(),
    }
}

fn number(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Résultat d'une analyse : `data` est vide et `error` renseigné en cas d'échec.
#[derive(Serialize)]
pub struct Scan<T> {
    ok: bool,
    data: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl<T> Scan<T> {
    fn from(result: Result<Vec<T>, String>) -> Self {
        match result {
            Ok(data) => Scan {
                ok: true,
                data,
                error: None,
            },
            Err(e) => {
                log::warn!("analyse échouée : {e}");
                Scan {
                    ok: false,
                    data: Vec::new(),
                    error: Some(SCAN_ERROR.into()),
                }
            }
        }
    }
}

#[derive(Serialize)]
pub struct RepairResult {
    ok: bool,
    fixed: usize,
    errors: usize,
}

impl RepairResult {
    fn from_launch(ok: bool, count: usize) -> Self {
        RepairResult {
            ok,
            fixed: if ok { count } else { 0 },
            errors: if ok { 0 } else { count },
        }
    }
}

// ─── Services ───────────────────────────────────────────────────────────────

struct CriticalService {
    name: &'static str,
    label: &'static str,
    description: &'static str,
    /// `true` si le service doit démarrer automatiquement, `false` s'il peut être manuel.
    automatic: bool,
}

const fn svc(
    name: &'static str,
    label: &'static str,
    description: &'static str,
    automatic: bool,
) -> CriticalService {
    CriticalService {
        name,
        label,
        description,
        automatic,
    }
}

const CRITICAL_SERVICES: [CriticalService; 12] = [
    svc(
        "wuauserv",
        "Windows Update",
        "Téléchargement des mises à jour Windows",
        true,
    ),
    svc(
        "WinDefend",
        "Windows Defender Antivirus",
        "Protection antivirus en temps réel",
        true,
    ),
    svc(
        "wscsvc",
        "Centre de sécurité Windows",
        "Surveillance de la sécurité système",
        true,
    ),
    svc(
        "MpsSvc",
        "Pare-feu Windows",
        "Protection du trafic réseau",
        true,
    ),
    svc(
        "BITS",
        "BITS",
        "Transfert de données en arrière-plan",
        false,
    ),
    svc(
        "cryptsvc",
        "Services de chiffrement",
        "Requis pour Windows Update et la sécurité",
        true,
    ),
    svc(
        "EventLog",
        "Journal d'événements Windows",
        "Enregistrement des événements système",
        true,
    ),
    svc(
        "RpcSs",
        "Appel de procédure distante",
        "Service fondamental du système Windows",
        true,
    ),
    svc(
        "AudioSrv",
        "Audio Windows",
        "Gestion des périphériques audio",
        true,
    ),
    svc(
        "Dnscache",
        "Client DNS",
        "Résolution des noms de domaine",
        true,
    ),
    svc(
        "Spooler",
        "Spouleur d'impression",
        "Gestion de la file d'impression",
        true,
    ),
    svc(
        "WSearch",
        "Recherche Windows",
        "Indexation pour la recherche dans l'Explorer",
        true,
    ),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    name: String,
    label: String,
    description: String,
    status: String,
    start_type: String,
    has_issue: bool,
}

fn service_has_issue(automatic: bool, status: &str, start_type: &str) -> bool {
    if automatic {
        status == "Stopped" || status == "Disabled" || start_type == "Disabled"
    } else {
        start_type == "Disabled"
    }
}

fn get_services() -> Result<Vec<ServiceInfo>, String> {
    let names: Vec<String> = CRITICAL_SERVICES
        .iter()
        .map(|s| ps::quote(s.name))
        .collect();
    let script = format!(
        r#"$names = @({})
$result = @($names | ForEach-Object {{
  $svc = Get-Service -Name $_ -ErrorAction SilentlyContinue
  if ($svc) {{
    [PSCustomObject]@{{
      name      = $svc.Name
      status    = $svc.Status.ToString()
      startType = $svc.StartType.ToString()
    }}
  }}
}})
if ($result.Count -eq 0) {{ '[]' }} else {{ $result | ConvertTo-Json -Depth 2 }}"#,
        names.join(",")
    );
    let rows = ps::json_rows(&ps::run(&script, SCAN_TIMEOUT)?)?;

    Ok(CRITICAL_SERVICES
        .iter()
        .map(|def| {
            let found = rows
                .iter()
                .find(|r| text(r, "name").eq_ignore_ascii_case(def.name));
            let status = found.map_or("Unknown".into(), |r| text_or(r, "status", "Unknown"));
            let start_type = found.map_or("Unknown".into(), |r| text_or(r, "startType", "Unknown"));
            ServiceInfo {
                name: def.name.into(),
                label: def.label.into(),
                description: def.description.into(),
                has_issue: service_has_issue(def.automatic, &status, &start_type),
                status,
                start_type,
            }
        })
        .collect())
}

fn fix_services(names: Vec<String>) -> RepairResult {
    if names.is_empty() {
        return RepairResult {
            ok: true,
            fixed: 0,
            errors: 0,
        };
    }
    // Seuls les services de la liste connue peuvent être modifiés.
    let known: Vec<&str> = CRITICAL_SERVICES
        .iter()
        .map(|s| s.name)
        .filter(|n| names.iter().any(|r| r.eq_ignore_ascii_case(n)))
        .collect();
    let rejected = names.len() - known.len();
    if known.is_empty() {
        return RepairResult {
            ok: false,
            fixed: 0,
            errors: rejected,
        };
    }

    let script: String = known
        .iter()
        .map(|name| {
            let n = ps::quote(name);
            format!(
                "$svc = Get-Service -Name {n} -ErrorAction SilentlyContinue\nif ($svc) {{\n  if ($svc.StartType -eq 'Disabled') {{ Set-Service -Name {n} -StartupType Automatic -ErrorAction SilentlyContinue }}\n  Start-Service -Name {n} -ErrorAction SilentlyContinue\n}}\n"
            )
        })
        .collect();
    let mut res = RepairResult::from_launch(ps::run_elevated(&script, FIX_TIMEOUT), known.len());
    res.errors += rejected;
    res.ok = res.ok && rejected == 0;
    res
}

#[tauri::command]
pub async fn repair_get_services() -> Result<Scan<ServiceInfo>, String> {
    blocking(|| Scan::from(get_services())).await
}

#[tauri::command]
pub async fn repair_fix_services(names: Vec<String>) -> Result<RepairResult, String> {
    blocking(move || fix_services(names)).await
}

// ─── Fichiers système ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SfcResult {
    ok: bool,
    status: &'static str,
    excerpt: String,
}

fn parse_sfc_output(output: &str) -> &'static str {
    if output.trim().is_empty() {
        return "unknown";
    }
    // Lignes [SR] de CBS.log : toujours en anglais.
    let lower = output.to_lowercase();
    if lower.contains("did not find any integrity violation") {
        "healthy"
    } else if lower.contains("found corrupt files and successfully repaired") {
        "repaired"
    } else if lower.contains("found corrupt files but was unable to fix") {
        "failed"
    } else {
        "unknown"
    }
}

fn run_sfc() -> SfcResult {
    // L'outil écrit dans la console (pas sur la sortie standard) : on lit donc le
    // journal CBS.log que Windows renseigne à chaque vérification.
    let (ok, output) = ps::run_elevated_with_result(SFC_TIMEOUT, |result| {
        format!(
            r#"& sfc /scannow
$log = Join-Path $env:SystemRoot 'Logs\CBS\CBS.log'
if (Test-Path -LiteralPath $log) {{
  Get-Content -LiteralPath $log -Tail 100 -ErrorAction SilentlyContinue |
    Where-Object {{ $_ -match '\[SR\]' }} |
    Out-File -LiteralPath {result} -Encoding UTF8 -Force
}} else {{
  'CBS log not found' | Out-File -LiteralPath {result} -Encoding UTF8 -Force
}}"#
        )
    });

    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let excerpt = lines[lines.len().saturating_sub(10)..].join("\n");
    SfcResult {
        ok,
        status: parse_sfc_output(&output),
        excerpt,
    }
}

#[tauri::command]
pub async fn repair_run_sfc() -> Result<SfcResult, String> {
    blocking(run_sfc).await
}

// ─── Périphériques ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverError {
    name: String,
    instance_id: String,
    status: String,
    device_class: String,
}

fn get_driver_errors() -> Result<Vec<DriverError>, String> {
    let script = r"$devices = @(Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.Status -notin @('OK', 'Unknown') } |
  Select-Object Name, InstanceId, Status, Class)
if ($devices.Count -eq 0) { '[]' } else { $devices | ConvertTo-Json -Depth 2 }";
    let rows = ps::json_rows(&ps::run(script, LONG_SCAN_TIMEOUT)?)?;
    Ok(rows
        .iter()
        .map(|r| DriverError {
            name: text_or(r, "Name", "Périphérique inconnu"),
            instance_id: text(r, "InstanceId"),
            status: text_or(r, "Status", "Unknown"),
            device_class: text(r, "Class"),
        })
        .collect())
}

fn fix_driver_errors(ids: Vec<String>) -> RepairResult {
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    if ids.is_empty() {
        return RepairResult {
            ok: true,
            fixed: 0,
            errors: 0,
        };
    }
    let list = ids
        .iter()
        .map(|id| ps::quote(id))
        .collect::<Vec<_>>()
        .join(",\n  ");
    let script = format!(
        r"$ids = @(
  {list}
)
foreach ($id in $ids) {{
  try {{
    Disable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
    Start-Sleep -Milliseconds 500
    Enable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
  }} catch {{ }}
}}"
    );
    RepairResult::from_launch(ps::run_elevated(&script, DRIVER_FIX_TIMEOUT), ids.len())
}

#[tauri::command]
pub async fn repair_get_driver_errors() -> Result<Scan<DriverError>, String> {
    blocking(|| Scan::from(get_driver_errors())).await
}

#[tauri::command]
pub async fn repair_fix_driver_errors(ids: Vec<String>) -> Result<RepairResult, String> {
    blocking(move || fix_driver_errors(ids)).await
}

// ─── Registre ───────────────────────────────────────────────────────────────

/// Seules les entrées de la liste des programmes installés peuvent être supprimées.
const UNINSTALL_ROOTS: [&str; 3] = [
    r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\",
    r"HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\",
    r"HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryIssue {
    name: String,
    install_location: String,
    registry_path: String,
}

fn get_registry_issues() -> Result<Vec<RegistryIssue>, String> {
    let script = r"$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
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

if ($orphaned.Count -eq 0) { '[]' } else { $orphaned | ConvertTo-Json -Depth 2 }";
    let rows = ps::json_rows(&ps::run(script, LONG_SCAN_TIMEOUT)?)?;
    Ok(rows
        .iter()
        .map(|r| RegistryIssue {
            name: text_or(r, "DisplayName", "Programme inconnu"),
            install_location: text(r, "InstallLocation"),
            registry_path: text(r, "PSPath"),
        })
        .collect())
}

/// Convertit un `PSPath` (`Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE\...`)
/// en (racine, nom de la clé) si, et seulement si, il désigne une entrée directe de
/// l'une des trois listes de programmes installés.
fn registry_target(path: &str) -> Option<(usize, String)> {
    const PROVIDER: &str = r"Microsoft.PowerShell.Core\Registry::";
    let mut p = path;
    if p.len() >= PROVIDER.len()
        && p.as_bytes()[..PROVIDER.len()].eq_ignore_ascii_case(PROVIDER.as_bytes())
    {
        p = &p[PROVIDER.len()..];
    }
    let hive = |full: &str, short: &str| -> Option<String> {
        (p.len() >= full.len() && p.as_bytes()[..full.len()].eq_ignore_ascii_case(full.as_bytes()))
            .then(|| format!("{short}{}", &p[full.len()..]))
    };
    let normalized = hive("HKEY_LOCAL_MACHINE", "HKLM:")
        .or_else(|| hive("HKEY_CURRENT_USER", "HKCU:"))
        .unwrap_or_else(|| p.to_string());

    for (index, root) in UNINSTALL_ROOTS.iter().enumerate() {
        let n = root.len();
        if normalized.len() > n && normalized.as_bytes()[..n].eq_ignore_ascii_case(root.as_bytes())
        {
            let key = &normalized[n..];
            if !key.contains('\\') && key != "." && key != ".." {
                return Some((index, key.to_string()));
            }
        }
    }
    None
}

fn fix_registry_issues(paths: Vec<String>) -> RepairResult {
    if paths.is_empty() {
        return RepairResult {
            ok: true,
            fixed: 0,
            errors: 0,
        };
    }
    let targets: Vec<(usize, String)> = paths.iter().filter_map(|p| registry_target(p)).collect();
    let rejected = paths.len() - targets.len();
    if targets.is_empty() {
        return RepairResult {
            ok: false,
            fixed: 0,
            errors: rejected,
        };
    }

    let roots = UNINSTALL_ROOTS
        .iter()
        .map(|r| ps::quote(r))
        .collect::<Vec<_>>()
        .join(",");
    let items = targets
        .iter()
        .map(|(root, key)| format!("@({root},{})", ps::quote(key)))
        .collect::<Vec<_>>()
        .join(",");

    let (_, output) = ps::run_elevated_with_result(REGISTRY_FIX_TIMEOUT, |result| {
        format!(
            r#"$roots = @({roots})
$items = @({items})
$fixed = 0
$errors = 0
foreach ($i in $items) {{
  $p = $roots[$i[0]] + $i[1]
  if (Test-Path -LiteralPath $p) {{
    try {{ Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop; $fixed++ }} catch {{ $errors++ }}
  }} else {{ $errors++ }}
}}
"$fixed|$errors" | Out-File -LiteralPath {result} -Encoding UTF8 -Force"#
        )
    });

    // Sans résultat (autorisation refusée), tout est considéré comme en erreur.
    let (fixed, errors) = match output.split_once('|') {
        Some((f, e)) => (f.trim().parse().unwrap_or(0), e.trim().parse().unwrap_or(0)),
        None => (0, targets.len()),
    };
    let errors = errors + rejected;
    RepairResult {
        ok: errors == 0,
        fixed,
        errors,
    }
}

#[tauri::command]
pub async fn repair_get_registry_issues() -> Result<Scan<RegistryIssue>, String> {
    blocking(|| Scan::from(get_registry_issues())).await
}

#[tauri::command]
pub async fn repair_fix_registry_issues(paths: Vec<String>) -> Result<RepairResult, String> {
    blocking(move || fix_registry_issues(paths)).await
}

// ─── Démarrage ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StartupItem {
    name: String,
    command: String,
    enabled: bool,
    source: &'static str,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StartupSource {
    User,
    System,
}

#[derive(Deserialize)]
pub struct StartupChange {
    name: String,
    source: StartupSource,
    enabled: bool,
}

fn get_startup_items() -> Result<Vec<StartupItem>, String> {
    let script = r"$skip = @('PSPath','PSParentPath','PSChildName','PSProvider','PSDrive')
$result = @()

# Entrées utilisateur (HKCU)
$runHkcu      = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
$approvedHkcu = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -ErrorAction SilentlyContinue
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
$runHklm      = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
$approvedHklm = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -ErrorAction SilentlyContinue
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

if ($result.Count -eq 0) { '[]' } else { $result | ConvertTo-Json -Depth 2 }";
    let rows = ps::json_rows(&ps::run(script, SCAN_TIMEOUT)?)?;
    Ok(rows
        .iter()
        .map(|r| StartupItem {
            name: text(r, "name"),
            command: text(r, "command"),
            enabled: r
                .get("enabled")
                .is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("True")),
            source: if text(r, "source") == "system" {
                "system"
            } else {
                "user"
            },
        })
        .collect())
}

fn set_startup_items(changes: Vec<StartupChange>) -> bool {
    let changes: Vec<&StartupChange> = changes.iter().filter(|c| !c.name.is_empty()).collect();
    if changes.is_empty() {
        return true;
    }
    let script: String = changes
        .iter()
        .map(|c| {
            let key = match c.source {
                StartupSource::System => r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
                StartupSource::User => r"HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            };
            let first_byte = if c.enabled { 2 } else { 3 };
            format!(
                "$p = '{key}'\nif (-not (Test-Path -LiteralPath $p)) {{ New-Item -Path $p -Force | Out-Null }}\n$d = [byte[]]({first_byte},0,0,0,0,0,0,0,0,0,0,0)\nSet-ItemProperty -LiteralPath $p -Name {} -Value $d -Type Binary -ErrorAction SilentlyContinue\n",
                ps::quote(&c.name)
            )
        })
        .collect();
    ps::run_elevated(&script, SMALL_FIX_TIMEOUT)
}

#[tauri::command]
pub async fn repair_get_startup_items() -> Result<Scan<StartupItem>, String> {
    blocking(|| Scan::from(get_startup_items())).await
}

#[derive(Serialize)]
pub struct Ack {
    ok: bool,
}

#[tauri::command]
pub async fn repair_set_startup_items(changes: Vec<StartupChange>) -> Result<Ack, String> {
    blocking(move || Ack {
        ok: set_startup_items(changes),
    })
    .await
}

// ─── Disques ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskVolume {
    letter: String,
    label: String,
    #[serde(rename = "sizeGB")]
    size_gb: f64,
    #[serde(rename = "freeGB")]
    free_gb: f64,
    health_status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDevice {
    name: String,
    health_status: String,
    #[serde(rename = "sizeGB")]
    size_gb: f64,
    volumes: Vec<DiskVolume>,
}

#[derive(Serialize)]
pub struct DiskHealth {
    ok: bool,
    disks: Vec<DiskDevice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn get_disk_health() -> Result<Vec<DiskDevice>, String> {
    let script = r#"$result = @(Get-Disk -ErrorAction SilentlyContinue | ForEach-Object {
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
if ($result.Count -eq 0) { '[]' } else { $result | ConvertTo-Json -Depth 4 }"#;
    let rows = ps::json_rows(&ps::run(script, SCAN_TIMEOUT)?)?;
    Ok(rows
        .iter()
        .map(|d| {
            let volumes = match d.get("volumes") {
                Some(Value::Array(items)) => items.iter().collect(),
                Some(v @ Value::Object(_)) => vec![v],
                _ => Vec::new(),
            };
            DiskDevice {
                name: text_or(d, "name", "Disque inconnu"),
                health_status: text_or(d, "healthStatus", "Unknown"),
                size_gb: number(d, "sizeGB"),
                volumes: volumes
                    .into_iter()
                    .map(|v| {
                        let letter = text(v, "letter");
                        DiskVolume {
                            label: text_or(v, "label", &format!("Disque {letter}")),
                            letter,
                            size_gb: number(v, "sizeGB"),
                            free_gb: number(v, "freeGB"),
                            health_status: text_or(v, "healthStatus", "Unknown"),
                        }
                    })
                    .collect(),
            }
        })
        .collect())
}

/// Garde les lettres de lecteur valides (A à Z), sans doublon, en majuscules.
fn valid_drive_letters(letters: &[String]) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for l in letters {
        let mut chars = l.trim().chars();
        if let (Some(c), None) = (chars.next(), chars.next())
            && c.is_ascii_alphabetic()
            && !out.contains(&c.to_ascii_uppercase())
        {
            out.push(c.to_ascii_uppercase());
        }
    }
    out
}

fn schedule_disk_check(letters: Vec<String>) -> bool {
    if letters.is_empty() {
        return true;
    }
    let valid = valid_drive_letters(&letters);
    if valid.len() != letters.len() {
        return false;
    }
    let script: String = valid.iter().map(|l| format!("chkntfs /c {l}:\n")).collect();
    ps::run_elevated(&script, SMALL_FIX_TIMEOUT)
}

#[tauri::command]
pub async fn repair_get_disk_health() -> Result<DiskHealth, String> {
    blocking(|| match get_disk_health() {
        Ok(disks) => DiskHealth {
            ok: true,
            disks,
            error: None,
        },
        Err(e) => {
            log::warn!("analyse des disques échouée : {e}");
            DiskHealth {
                ok: false,
                disks: Vec::new(),
                error: Some(SCAN_ERROR.into()),
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn repair_schedule_disk_check(letters: Vec<String>) -> Result<Ack, String> {
    blocking(move || Ack {
        ok: schedule_disk_check(letters),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn services_scan_returns_every_known_service() {
        let services = get_services().expect("analyse des services");
        assert_eq!(services.len(), CRITICAL_SERVICES.len());
        let rpc = services.iter().find(|s| s.name == "RpcSs").unwrap();
        assert_eq!(rpc.status, "Running");
        assert!(!rpc.has_issue);
    }

    #[test]
    fn issue_rules_match_expectations() {
        assert!(service_has_issue(true, "Stopped", "Automatic"));
        assert!(!service_has_issue(true, "Running", "Automatic"));
        assert!(!service_has_issue(false, "Stopped", "Manual"));
        assert!(service_has_issue(false, "Stopped", "Disabled"));
    }

    #[test]
    fn startup_scan_works() {
        let items = get_startup_items().expect("analyse du démarrage");
        println!("{} éléments de démarrage", items.len());
    }

    #[test]
    fn disk_scan_finds_a_system_disk() {
        let disks = get_disk_health().expect("analyse des disques");
        assert!(
            disks
                .iter()
                .any(|d| d.volumes.iter().any(|v| v.letter == "C"))
        );
    }

    #[test]
    fn driver_scan_works() {
        let errors = get_driver_errors().expect("analyse des périphériques");
        println!("{} périphériques en erreur", errors.len());
    }

    #[test]
    fn registry_scan_works() {
        let issues = get_registry_issues().expect("analyse du registre");
        println!("{} entrées orphelines", issues.len());
        for i in &issues {
            assert!(
                registry_target(&i.registry_path).is_some(),
                "chemin refusé : {}",
                i.registry_path
            );
        }
    }

    #[test]
    fn sfc_output_is_classified() {
        assert_eq!(parse_sfc_output(""), "unknown");
        assert_eq!(
            parse_sfc_output(
                "[SR] Verify complete\n[SR] Windows Resource Protection did not find any integrity violations."
            ),
            "healthy"
        );
        assert_eq!(
            parse_sfc_output(
                "Windows Resource Protection found corrupt files and successfully repaired them"
            ),
            "repaired"
        );
        assert_eq!(
            parse_sfc_output("found corrupt files but was unable to fix some of them"),
            "failed"
        );
        assert_eq!(parse_sfc_output("autre chose"), "unknown");
    }

    #[test]
    fn registry_target_accepts_only_uninstall_entries() {
        let ok = |p: &str| registry_target(p);
        assert_eq!(
            ok(
                r"Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{ABC-1}"
            ),
            Some((0, "{ABC-1}".into()))
        );
        assert_eq!(
            ok(
                r"Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\App"
            ),
            Some((1, "App".into()))
        );
        assert_eq!(
            ok(
                r"microsoft.powershell.core\registry::hkey_current_user\software\microsoft\windows\currentversion\uninstall\MonApp"
            ),
            Some((2, "MonApp".into()))
        );
        assert_eq!(
            ok(r"HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Direct"),
            Some((2, "Direct".into()))
        );

        // Refusés : autre branche, la racine elle-même, sous-clés, remontée de dossier.
        assert_eq!(ok(r"HKLM:\SOFTWARE\Microsoft"), None);
        assert_eq!(ok(r"HKLM:\SYSTEM\CurrentControlSet\Services\Foo"), None);
        assert_eq!(
            ok(r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\"),
            None
        );
        assert_eq!(
            ok(r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\A\B"),
            None
        );
        assert_eq!(
            ok(r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\.."),
            None
        );
        assert_eq!(ok(""), None);
    }

    #[test]
    fn fix_services_refuses_unknown_names() {
        let res = fix_services(vec!["TermService".into(), "x'; calc; '".into()]);
        assert!(!res.ok);
        assert_eq!((res.fixed, res.errors), (0, 2));
    }

    #[test]
    fn drive_letters_are_validated() {
        let l =
            |v: &[&str]| valid_drive_letters(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(l(&["c", "D", "c"]), vec!['C', 'D']);
        assert!(l(&["C:", "1", "", "CD", "é"]).is_empty());
        assert!(!schedule_disk_check(vec!["C; calc".into()]));
    }
}
