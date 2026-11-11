//! Mises à jour : logiciels (via le gestionnaire de paquets de Windows) et pilotes.
//!
//! Le gestionnaire est lancé directement avec une liste d'arguments, sans passer par
//! un interpréteur : un identifiant de programme ne peut pas devenir une commande.
//! Les rapports d'échec sont écrits dans `<données de l'app>\logs`.

use crate::diagnose::{self, FailureKind, GENERIC_ERROR};
use crate::report::{self, Entry, Outcome};
use crate::{hidden, proc, ps};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const SOURCE_UPDATE_TIMEOUT: Duration = Duration::from_secs(30);
/// Les gros programmes (Docker, jeux…) mettent longtemps à se télécharger et à s'installer.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Au bout de ce temps, l'interface prévient que l'installation est longue (ou attend peut-être
/// l'autorisation de Windows, affichée dans la barre des tâches).
const SLOW_INSTALL_AFTER: Duration = Duration::from_secs(60);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
const ELEVATED_INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DRIVER_SCAN_TIMEOUT: Duration = Duration::from_secs(60);
const DRIVER_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const NO_UPDATER_ERROR: &str =
    "Le gestionnaire de mises à jour de Windows est introuvable sur ce PC";

/// Codes « installé avec succès, redémarrage nécessaire » : ceux des installateurs Windows
/// (3010, 1641) et ceux de winget (« redémarrez pour terminer », « le PC va redémarrer »).
const REBOOT_CODES: [i64; 4] = [3010, 1641, 0x8A15_0109, 0x8A15_010B];

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

// ─── Le gestionnaire de paquets ─────────────────────────────────────────────

static WINGET: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Localise le vrai `winget.exe` : l'alias d'exécution n'est pas utilisable depuis un
/// sous-processus non interactif.
fn find_winget() -> Option<PathBuf> {
    if let Ok(cache) = WINGET.lock()
        && let Some(path) = cache.clone()
    {
        return Some(path);
    }
    let dir = ps::run(
        "Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation",
        Duration::from_secs(10),
    )
    .ok()?;
    if dir.is_empty() {
        return None;
    }
    let exe = Path::new(&dir).join("winget.exe");
    if !exe.is_file() {
        return None;
    }
    if let Ok(mut cache) = WINGET.lock() {
        *cache = Some(exe.clone());
    }
    Some(exe)
}

struct WingetRun {
    /// Code de sortie, ou -1 si le programme n'a pas pu se terminer normalement.
    code: i64,
    stdout: String,
    /// Sortie standard puis sortie d'erreur, comme les voit l'utilisateur.
    combined: String,
}

fn run_winget(winget: &Path, args: &[&str], timeout: Duration) -> Result<WingetRun, String> {
    run_winget_watched(winget, args, timeout, None, &mut || {})
}

/// Comme `run_winget`, et appelle `on_slow` une fois si la commande dure plus de `slow_after`.
fn run_winget_watched(
    winget: &Path,
    args: &[&str],
    timeout: Duration,
    slow_after: Option<Duration>,
    on_slow: &mut dyn FnMut(),
) -> Result<WingetRun, String> {
    let mut cmd = proc::hidden(&winget.to_string_lossy());
    cmd.args(args);
    match proc::capture_watched(cmd, timeout, slow_after, on_slow) {
        Ok(Some(c)) => {
            let stdout = String::from_utf8_lossy(&c.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&c.stderr);
            Ok(WingetRun {
                // Les codes Windows sont des entiers non signés (ex. 0x8A150006).
                code: c.status.code().map_or(-1, |code| i64::from(code as u32)),
                combined: format!("{stdout}{stderr}").trim().to_string(),
                stdout,
            })
        }
        Ok(None) => Err("délai dépassé".into()),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Liste des logiciels à mettre à jour ────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdate {
    id: String,
    name: String,
    current_version: String,
    available_version: String,
    source: String,
    /// La version installée n'est pas lisible (« Unknown », « < x ») : le programme sera
    /// listé à chaque analyse, même après une vraie mise à jour.
    version_unknown: bool,
}

/// Position (en caractères) du début de chaque mot de l'en-tête d'un tableau.
fn header_columns(header: &str) -> Vec<usize> {
    let mut cols = Vec::new();
    let mut in_word = false;
    for (i, c) in header.chars().enumerate() {
        if c.is_whitespace() {
            in_word = false;
        } else if !in_word {
            cols.push(i);
            in_word = true;
        }
    }
    cols
}

/// Lit le tableau affiché par `winget upgrade` (colonnes à positions fixes). Ça marche
/// en français comme en anglais, car on se repère aux positions et non aux titres.
fn parse_winget_table(output: &str) -> Vec<SoftwareUpdate> {
    // Le spinner de progression utilise des retours chariot seuls.
    let lines: Vec<&str> = output
        .split(['\r', '\n'])
        .filter(|l| !l.is_empty())
        .collect();

    let Some(sep) = lines.iter().position(|l| {
        let t = l.trim();
        t.len() >= 20 && t.chars().take(20).all(|c| c == '-')
    }) else {
        return Vec::new();
    };
    if sep < 1 {
        return Vec::new();
    }

    let cols = header_columns(lines[sep - 1]);
    if cols.len() < 4 {
        return Vec::new();
    }

    let mut packages = Vec::new();
    for line in &lines[sep + 1..] {
        if line.trim().is_empty() {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let value = |idx: usize| -> String {
            let start = cols[idx].min(chars.len());
            let end = cols
                .get(idx + 1)
                .map_or(chars.len(), |&e| e.min(chars.len()));
            chars[start..end.max(start)]
                .iter()
                .collect::<String>()
                .trim()
                .to_string()
        };
        let (name, id, version, available) = (value(0), value(1), value(2), value(3));
        let source = if cols.len() > 4 {
            value(4)
        } else {
            String::new()
        };
        // Les phrases de fin de tableau ne sont pas des programmes : un identifiant est un seul mot.
        if !is_valid_package_id(&id) || available.is_empty() {
            continue;
        }
        let current_version = if version.is_empty() {
            "Inconnu".to_string()
        } else {
            version
        };
        packages.push(SoftwareUpdate {
            name: if name.is_empty() { id.clone() } else { name },
            id,
            version_unknown: is_version_unknown(&current_version),
            current_version,
            available_version: available,
            source: if source.is_empty() {
                "winget".into()
            } else {
                source
            },
        });
    }
    packages
}

#[derive(Serialize)]
pub struct ListResult<T> {
    ok: bool,
    data: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl<T> ListResult<T> {
    fn ok(data: Vec<T>) -> Self {
        ListResult {
            ok: true,
            data,
            error: None,
        }
    }
    fn err(message: &str) -> Self {
        ListResult {
            ok: false,
            data: Vec::new(),
            error: Some(message.into()),
        }
    }
}

/// Résultat de l'analyse des logiciels : la liste proposée, et à part les programmes que
/// l'utilisateur a masqués (pour qu'il puisse les proposer de nouveau).
#[derive(Serialize)]
pub struct SoftwareScan {
    ok: bool,
    data: Vec<SoftwareUpdate>,
    hidden: Vec<SoftwareUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl SoftwareScan {
    fn failed(message: &str) -> Self {
        SoftwareScan {
            ok: false,
            data: Vec::new(),
            hidden: Vec::new(),
            error: Some(message.into()),
        }
    }
}

/// Sépare les programmes proposés de ceux que l'utilisateur a masqués.
fn split_hidden(
    packages: Vec<SoftwareUpdate>,
    hidden_ids: &[String],
) -> (Vec<SoftwareUpdate>, Vec<SoftwareUpdate>) {
    packages
        .into_iter()
        .partition(|p| !hidden::contains(hidden_ids, &p.id))
}

fn get_software(hidden_ids: &[String]) -> SoftwareScan {
    let Some(winget) = find_winget() else {
        return SoftwareScan::failed(NO_UPDATER_ERROR);
    };
    // Rafraîchit les sources avant l'analyse pour éviter les faux positifs.
    let _ = run_winget(&winget, &["source", "update"], SOURCE_UPDATE_TIMEOUT);

    match run_winget(
        &winget,
        &["upgrade", "--include-unknown", "--accept-source-agreements"],
        LIST_TIMEOUT,
    ) {
        Ok(run) => {
            let packages = parse_winget_table(&run.stdout);
            log::info!("[mises à jour] {} programme(s) détecté(s)", packages.len());
            let (data, hidden) = split_hidden(packages, hidden_ids);
            SoftwareScan {
                ok: true,
                data,
                hidden,
                error: None,
            }
        }
        Err(e) => {
            log::warn!("[mises à jour] analyse échouée : {e}");
            SoftwareScan::failed(GENERIC_ERROR)
        }
    }
}

/// Dossier de données de l'application, où vit la liste des programmes masqués.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| {
        log::warn!("dossier de données introuvable : {e}");
        GENERIC_ERROR.to_string()
    })
}

#[tauri::command]
pub async fn updates_get_software(app: AppHandle) -> Result<SoftwareScan, String> {
    // Sans liste lisible, rien n'est masqué : l'analyse ne doit pas échouer pour ça.
    let hidden_ids = data_dir(&app).map(|d| hidden::load(&d)).unwrap_or_default();
    blocking(move || get_software(&hidden_ids)).await
}

/// Identifiants des programmes masqués (même ceux qui n'ont plus de mise à jour en attente).
#[tauri::command]
pub async fn updates_get_hidden(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = data_dir(&app)?;
    blocking(move || hidden::load(&dir)).await
}

fn hidden_change(
    app: &AppHandle,
    change: impl FnOnce(&Path) -> std::io::Result<Vec<String>> + Send + 'static,
) -> impl std::future::Future<Output = Result<Vec<String>, String>> {
    let dir = data_dir(app);
    async move {
        let dir = dir?;
        blocking(move || change(&dir)).await?.map_err(|e| {
            log::warn!("liste des programmes masqués non enregistrée : {e}");
            GENERIC_ERROR.to_string()
        })
    }
}

/// Ne plus proposer ce programme. Renvoie la liste des programmes masqués.
#[tauri::command]
pub async fn updates_hide(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    if !is_valid_package_id(&id) {
        return Err(GENERIC_ERROR.into());
    }
    hidden_change(&app, move |dir| hidden::hide(dir, &id)).await
}

/// Proposer de nouveau ce programme. Renvoie la liste des programmes masqués.
#[tauri::command]
pub async fn updates_unhide(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    hidden_change(&app, move |dir| hidden::unhide(dir, &id)).await
}

/// Proposer de nouveau tous les programmes masqués.
#[tauri::command]
pub async fn updates_unhide_all(app: AppHandle) -> Result<Vec<String>, String> {
    hidden_change(&app, hidden::unhide_all).await
}

// ─── Pilotes ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DriverUpdate {
    title: String,
    #[serde(rename = "sizeMB")]
    size_mb: f64,
}

const DRIVER_SCAN_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
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
}"#;

const DRIVER_INSTALL_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
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
}"#;

fn get_drivers() -> ListResult<DriverUpdate> {
    let rows = ps::run(DRIVER_SCAN_SCRIPT, DRIVER_SCAN_TIMEOUT).and_then(|out| ps::json_rows(&out));
    match rows {
        Ok(rows) => ListResult::ok(
            rows.iter()
                .map(|r| DriverUpdate {
                    title: r
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    size_mb: r.get("sizeMB").and_then(|v| v.as_f64()).unwrap_or(0.0),
                })
                .collect(),
        ),
        Err(e) => {
            log::warn!("[pilotes] analyse échouée : {e}");
            ListResult::err(GENERIC_ERROR)
        }
    }
}

#[derive(Serialize)]
pub struct InstallResult {
    ok: bool,
    installed: u32,
    errors: u32,
}

#[tauri::command]
pub async fn updates_get_drivers() -> Result<ListResult<DriverUpdate>, String> {
    blocking(get_drivers).await
}

#[tauri::command]
pub async fn updates_install_drivers() -> Result<InstallResult, String> {
    blocking(|| {
        let ok = ps::run_elevated(DRIVER_INSTALL_SCRIPT, DRIVER_INSTALL_TIMEOUT);
        InstallResult {
            ok,
            installed: u32::from(ok),
            errors: u32::from(!ok),
        }
    })
    .await
}

// ─── Installation des logiciels ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct Package {
    id: String,
    name: String,
    /// Version installée avant la mise à jour, telle qu'affichée par l'analyse.
    #[serde(default, rename = "currentVersion")]
    current_version: Option<String>,
    /// Version que l'analyse annonçait (pour le rapport).
    #[serde(default, rename = "availableVersion")]
    available_version: Option<String>,
}

/// Un identifiant est un seul mot, sans caractère de contrôle ni tiret initial (ce serait
/// pris pour une option). Le gestionnaire est lancé sans interpréteur et l'identifiant est
/// échappé dans le script administrateur : rien d'autre n'est à craindre.
fn is_valid_package_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 200
        && !id.starts_with('-')
        && !id.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Ce que révèle une nouvelle lecture de la version après une installation réussie.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    /// Le programme n'apparaît plus comme ayant une mise à jour : la nouvelle version est bien là.
    Confirmed,
    /// Le programme est toujours listé avec une mise à jour : l'ancienne version est encore détectée.
    StillOutdated,
    /// Impossible de conclure (version jamais détectable, programme non reconnu, vérification échouée).
    Unverifiable,
}

/// Les versions que le gestionnaire ne sait pas lire : « Unknown », « < 1.2.3 »…
fn is_version_unknown(version: &str) -> bool {
    let v = version.trim().to_lowercase();
    v.is_empty() || v == "unknown" || v == "inconnu" || v.starts_with('<')
}

/// Nombre de colonnes de l'en-tête du tableau (0 s'il n'y en a pas). Sans mise à jour en
/// attente, le gestionnaire n'affiche pas la colonne « Disponible ».
fn table_column_count(output: &str) -> usize {
    let lines: Vec<&str> = output
        .split(['\r', '\n'])
        .filter(|l| !l.is_empty())
        .collect();
    let separator = lines.iter().position(|l| {
        let t = l.trim();
        t.len() >= 20 && t.chars().take(20).all(|c| c == '-')
    });
    match separator {
        Some(sep) if sep >= 1 => lines[sep - 1].split_whitespace().count(),
        _ => 0,
    }
}

/// Analyse la sortie de `winget list --id <id> --exact` : la colonne « Disponible » n'est
/// remplie que si une version plus récente existe.
fn classify_verification(output: &str, id: &str, before: Option<&str>) -> Verification {
    // Avec une colonne « Disponible », une ligne qui a une valeur dedans a une mise à jour en attente.
    let listed = if table_column_count(output) >= 5 {
        parse_winget_table(output)
            .into_iter()
            .find(|p| p.id.eq_ignore_ascii_case(id))
    } else {
        None
    };
    match listed {
        Some(row) => {
            if before.is_some_and(is_version_unknown) || is_version_unknown(&row.current_version) {
                Verification::Unverifiable
            } else {
                Verification::StillOutdated
            }
        }
        // Programme trouvé, sans mise à jour en attente : la nouvelle version est détectée.
        None if output.to_lowercase().contains(&id.to_lowercase()) => Verification::Confirmed,
        // Programme introuvable ou sortie incompréhensible.
        None => Verification::Unverifiable,
    }
}

/// Arguments de la vérification. Elle ne doit **jamais** installer quoi que ce soit : `upgrade
/// --id` lance la mise à jour, `list` ne fait que lire.
fn verify_args(id: &str) -> [&str; 6] {
    [
        "list",
        "--id",
        id,
        "--exact",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]
}

/// Ce que révèle la relecture d'un programme après une installation réussie.
#[derive(Debug)]
struct Verified {
    result: Verification,
    /// Version installée relue (même quand le programme est à jour).
    installed: Option<String>,
}

/// Version installée d'un programme dans le tableau de `winget list` (avec ou sans colonne
/// « Disponible »).
fn installed_version(output: &str, id: &str) -> Option<String> {
    let lines: Vec<&str> = output
        .split(['\r', '\n'])
        .filter(|l| !l.is_empty())
        .collect();
    let sep = lines.iter().position(|l| {
        let t = l.trim();
        t.len() >= 20 && t.chars().take(20).all(|c| c == '-')
    })?;
    if sep < 1 {
        return None;
    }
    let cols = header_columns(lines[sep - 1]);
    if cols.len() < 3 {
        return None;
    }
    let cell = |chars: &[char], idx: usize| -> String {
        let start = cols[idx].min(chars.len());
        let end = cols
            .get(idx + 1)
            .map_or(chars.len(), |&e| e.min(chars.len()));
        chars[start..end.max(start)]
            .iter()
            .collect::<String>()
            .trim()
            .to_string()
    };
    lines[sep + 1..]
        .iter()
        .find_map(|line| {
            let chars: Vec<char> = line.chars().collect();
            cell(&chars, 1)
                .eq_ignore_ascii_case(id)
                .then(|| cell(&chars, 2))
        })
        .filter(|v| !v.is_empty())
}

/// Relit l'état du programme après une installation réussie.
fn verify_install(winget: &Path, id: &str, before: Option<&str>) -> Verified {
    match run_winget(winget, &verify_args(id), VERIFY_TIMEOUT) {
        Ok(run) => {
            let result = classify_verification(&run.stdout, id, before);
            let installed = installed_version(&run.stdout, id);
            log::info!("[mises à jour] vérification de {id} : {result:?}");
            Verified { result, installed }
        }
        Err(e) => {
            log::warn!("[mises à jour] vérification de {id} impossible : {e}");
            Verified {
                result: Verification::Unverifiable,
                installed: None,
            }
        }
    }
}

fn install_args(id: &str) -> [&str; 9] {
    [
        "upgrade",
        "--id",
        id,
        "--include-unknown",
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--force",
        "--disable-interactivity",
    ]
}

fn is_spinner(line: &str) -> bool {
    matches!(line, "-" | "\\" | "|" | "/")
}

fn clean_winget_output(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !is_spinner(l))
        .map(String::from)
        .collect()
}

/// Redémarrage à prévoir après une installation réussie : de l'application ou du PC.
fn detect_reboot(code: i64, output: &str) -> Option<&'static str> {
    static APP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)redémarr[a-z]*\s.{0,40}(?:application|logiciel)|restart\s.{0,40}application",
        )
        .unwrap()
    });
    static SYSTEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)redémarr[a-z]*\s.{0,40}(?:ordinateur|système|pc|windows)|reboot\s.{0,40}(?:required|computer|machine)")
            .unwrap()
    });
    if REBOOT_CODES.contains(&code) {
        Some("system")
    } else if APP.is_match(output) {
        Some("app")
    } else if SYSTEM.is_match(output) {
        Some("system")
    } else {
        None
    }
}

fn logs_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Date et heure affichées dans les rapports.
fn now_label() -> String {
    chrono::Local::now().format("%d/%m/%Y %H:%M:%S").to_string()
}

/// Avancement de l'installation d'un programme, envoyé à l'interface au fil de l'eau.
#[derive(Serialize, Clone)]
pub struct Progress {
    id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Type d'échec : l'interface en tire le bouton à proposer.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reboot: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification: Option<Verification>,
    /// Vrai quand l'installation dure : l'interface le signale à l'utilisateur.
    #[serde(skip_serializing_if = "Option::is_none")]
    slow: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamResult {
    log_file: Option<String>,
}

/// Installe les programmes un par un. `emit` reçoit la progression, `report_dir` est le dossier
/// où écrire le rapport en cas d'échec.
fn install_software_stream(
    packages: Vec<Package>,
    emit: &dyn Fn(Progress),
    report_dir: Option<&Path>,
) -> StreamResult {
    if packages.is_empty() {
        return StreamResult { log_file: None };
    }
    install_with(
        packages,
        find_winget(),
        &InstallTimings::default(),
        emit,
        report_dir,
    )
}

/// Durées de l'installation, réglables pour les tests.
struct InstallTimings {
    /// Au-delà, l'installation est arrêtée.
    timeout: Duration,
    /// Au-delà, l'interface est prévenue que l'installation est longue.
    slow_after: Duration,
}

impl Default for InstallTimings {
    fn default() -> Self {
        InstallTimings {
            timeout: INSTALL_TIMEOUT,
            slow_after: SLOW_INSTALL_AFTER,
        }
    }
}

fn install_with(
    packages: Vec<Package>,
    winget: Option<PathBuf>,
    timings: &InstallTimings,
    emit: &dyn Fn(Progress),
    report_dir: Option<&Path>,
) -> StreamResult {
    let mut entries: Vec<Entry> = Vec::new();

    for Package {
        id,
        name,
        current_version,
        available_version,
    } in packages
    {
        emit(Progress {
            id: id.clone(),
            status: "installing",
            reason: None,
            kind: None,
            reboot: None,
            verification: None,
            slow: None,
        });
        let mut entry = Entry {
            name: name.clone(),
            id: id.clone(),
            before: current_version.clone(),
            expected: available_version,
            after: None,
            outcome: Outcome::Unverifiable,
        };

        let Some(winget_path) = winget.as_deref().filter(|_| is_valid_package_id(&id)) else {
            let why = if winget.is_none() {
                "gestionnaire introuvable"
            } else {
                "identifiant invalide"
            };
            entry.outcome = Outcome::Failed {
                message: GENERIC_ERROR.into(),
                code: None,
                detail: vec![why.into()],
            };
            entries.push(entry);
            emit(Progress {
                id,
                status: "error",
                reason: Some(GENERIC_ERROR.into()),
                kind: Some(FailureKind::Other),
                reboot: None,
                verification: None,
                slow: None,
            });
            continue;
        };

        let result = run_winget_watched(
            winget_path,
            &install_args(&id),
            timings.timeout,
            Some(timings.slow_after),
            &mut || {
                emit(Progress {
                    id: id.clone(),
                    status: "installing",
                    reason: None,
                    kind: None,
                    reboot: None,
                    verification: None,
                    slow: Some(true),
                });
            },
        );
        let (code, captured) = match result {
            Ok(run) => (run.code, run.combined),
            Err(e) => (-1, e),
        };
        let ok = code == 0 || REBOOT_CODES.contains(&code);
        let reboot = if ok {
            detect_reboot(code, &captured)
        } else {
            None
        };
        log::info!(
            "[mises à jour] {} {id} (code={code})\n{captured}",
            if ok { "OK" } else { "ÉCHEC" }
        );

        if ok {
            // Après un redémarrage, la version n'est relue qu'au prochain lancement de Windows :
            // inutile de vérifier tout de suite.
            let verified = match reboot {
                None => Some(verify_install(winget_path, &id, current_version.as_deref())),
                Some(_) => None,
            };
            let verification = verified.as_ref().map(|v| v.result);
            entry.after = verified.and_then(|v| v.installed);
            entry.outcome = match (reboot, verification) {
                (Some(restart), _) => Outcome::Restart(restart),
                (None, Some(Verification::Confirmed)) => Outcome::Confirmed,
                (None, Some(Verification::StillOutdated)) => Outcome::StillOutdated,
                (None, _) => Outcome::Unverifiable,
            };
            emit(Progress {
                id,
                status: "ok",
                reason: None,
                kind: None,
                reboot,
                verification,
                slow: None,
            });
        } else {
            let diagnosis = diagnose::diagnose(&captured, code);
            entry.outcome = Outcome::Failed {
                message: diagnosis.message.clone(),
                code: Some(code),
                detail: clean_winget_output(&captured),
            };
            emit(Progress {
                id,
                status: "error",
                reason: Some(diagnosis.message),
                kind: Some(diagnosis.kind),
                reboot: None,
                verification: None,
                slow: None,
            });
        }
        entries.push(entry);
    }

    if entries.is_empty() {
        return StreamResult { log_file: None };
    }
    // Un rapport par session, réussites comme échecs : de quoi comparer avec l'analyse suivante.
    let manager = winget
        .as_ref()
        .map_or("introuvable".to_string(), |p| p.display().to_string());
    let text = report::build(
        "Rapport de mise à jour",
        &now_label(),
        &entries,
        Some(&manager),
    );
    StreamResult {
        log_file: report::write(report_dir, &text),
    }
}

#[tauri::command]
pub async fn updates_install_software_stream(
    app: AppHandle,
    packages: Vec<Package>,
    on_progress: Channel<Progress>,
) -> Result<StreamResult, String> {
    blocking(move || {
        let dir = logs_dir(&app);
        install_software_stream(
            packages,
            &|p| {
                let _ = on_progress.send(p);
            },
            dir.as_deref(),
        )
    })
    .await
}

// ─── Installation avec les droits administrateur ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevatedResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reboot: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification: Option<Verification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_file: Option<String>,
}

fn refused(reason: &str, kind: FailureKind) -> ElevatedResult {
    ElevatedResult {
        ok: false,
        reason: Some(reason.into()),
        kind: Some(kind),
        reboot: None,
        verification: None,
        log_file: None,
    }
}

fn install_elevated(app: &AppHandle, pkg: Package) -> ElevatedResult {
    let Some(winget) = find_winget() else {
        return refused(NO_UPDATER_ERROR, FailureKind::Other);
    };
    if !is_valid_package_id(&pkg.id) {
        return refused(GENERIC_ERROR, FailureKind::Other);
    }
    let Package {
        id,
        name,
        current_version,
        available_version,
    } = pkg;

    // Le script élevé écrit le code de sortie et la sortie dans un seul fichier JSON.
    let (launched, result) = ps::run_elevated_with_result(ELEVATED_INSTALL_TIMEOUT, |result| {
        format!(
            r"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out  = & {winget} upgrade --id {id} --include-unknown --silent --accept-source-agreements --accept-package-agreements --force --disable-interactivity 2>&1
$code = $LASTEXITCODE
@{{ code = $code; out = ($out | Out-String) }} | ConvertTo-Json -Compress | Out-File -LiteralPath {result} -Encoding UTF8 -Force",
            winget = ps::quote(&winget.to_string_lossy()),
            id = ps::quote(&id),
        )
    });

    let parsed: Option<serde_json::Value> = serde_json::from_str(&result).ok();
    let Some(parsed) = parsed.filter(|_| launched) else {
        // Windows a peut-être été refusé : on laisse la possibilité de réessayer.
        return refused(
            "L'autorisation a été refusée ou la mise à jour annulée",
            FailureKind::NeedsPermission,
        );
    };
    let code = parsed
        .get("code")
        .and_then(|c| c.as_i64())
        .map_or(-1, |c| i64::from(c as u32));
    let output = parsed
        .get("out")
        .and_then(|o| o.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let ok = code == 0 || REBOOT_CODES.contains(&code);
    log::info!(
        "[mises à jour admin] {} {id} (code={code})\n{output}",
        if ok { "OK" } else { "ÉCHEC" }
    );

    // Comme pour une session normale, le nouvel essai laisse un rapport, réussi ou non.
    let dir = logs_dir(app);
    let manager = winget.display().to_string();
    let write_session = |entry: Entry| {
        let text = report::build(
            "Rapport de mise à jour (nouvel essai avec autorisation)",
            &now_label(),
            &[entry],
            Some(&manager),
        );
        report::write(dir.as_deref(), &text)
    };
    let mut entry = Entry {
        name: name.clone(),
        id: id.clone(),
        before: current_version.clone(),
        expected: available_version,
        after: None,
        outcome: Outcome::Unverifiable,
    };

    if ok {
        let reboot = detect_reboot(code, &output);
        let verified = match reboot {
            None => Some(verify_install(&winget, &id, current_version.as_deref())),
            Some(_) => None,
        };
        let verification = verified.as_ref().map(|v| v.result);
        entry.after = verified.and_then(|v| v.installed);
        entry.outcome = match (reboot, verification) {
            (Some(restart), _) => Outcome::Restart(restart),
            (None, Some(Verification::Confirmed)) => Outcome::Confirmed,
            (None, Some(Verification::StillOutdated)) => Outcome::StillOutdated,
            (None, _) => Outcome::Unverifiable,
        };
        return ElevatedResult {
            ok: true,
            reason: None,
            kind: None,
            reboot,
            verification,
            log_file: write_session(entry),
        };
    }

    // L'autorisation est déjà donnée : si le diagnostic parle encore d'autorisation, c'est que
    // l'installation a planté, le plus souvent parce que le programme est resté ouvert.
    let diagnosis = diagnose::diagnose(&output, code);
    let (kind, reason) = if diagnosis.kind == FailureKind::NeedsPermission {
        (
            FailureKind::CloseApp,
            format!(
                "L'installation n'a pas abouti malgré l'autorisation. Fermez complètement {name} (y compris son icône près de l'horloge), puis réessayez"
            ),
        )
    } else {
        (diagnosis.kind, diagnosis.message)
    };
    entry.outcome = Outcome::Failed {
        message: reason.clone(),
        code: Some(code),
        detail: clean_winget_output(&output),
    };
    ElevatedResult {
        ok: false,
        reason: Some(reason),
        kind: Some(kind),
        reboot: None,
        verification: None,
        log_file: write_session(entry),
    }
}

#[tauri::command]
pub async fn updates_install_elevated(
    app: AppHandle,
    pkg: Package,
) -> Result<ElevatedResult, String> {
    blocking(move || install_elevated(&app, pkg)).await
}

// ─── Fermeture du programme concerné ────────────────────────────────────────

/// Mots trop génériques pour identifier un programme.
const FILLER_WORDS: &[&str] = &[
    "software",
    "application",
    "app",
    "setup",
    "installer",
    "update",
    "desktop",
    "client",
    "for",
    "windows",
    "edition",
    "inc",
    "corp",
    "corporation",
    "ltd",
    "llc",
    "gmbh",
    "64-bit",
    "32-bit",
    "x64",
    "x86",
    "studio",
    "bit",
];

#[derive(Deserialize)]
pub struct NamedPackage {
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidates: Option<Vec<String>>,
}

fn failure(reason: &'static str) -> CloseResult {
    CloseResult {
        ok: false,
        process_name: None,
        reason: Some(reason),
        candidates: None,
    }
}

fn significant_words(name: &str) -> Vec<String> {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() >= 3 && !FILLER_WORDS.contains(&w.to_lowercase().as_str()))
        .map(String::from)
        .collect()
}

/// Recherche heuristique : il n'existe pas de lien fiable entre un identifiant de paquet
/// et un processus, donc on compare les mots significatifs du nom du programme à la
/// description des applications ouvertes. Ni cette application ni ses composants
/// d'affichage ne sont jamais visés.
fn close_related_app(name: &str) -> CloseResult {
    let words = significant_words(name);
    if words.is_empty() {
        return failure("not_found");
    }
    let list = words
        .iter()
        .map(|w| ps::quote(w))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"$words = @({list}) | ForEach-Object {{ $_.ToLower() }}
$candidates = @()
foreach ($p in (Get-Process | Where-Object {{ $_.Id -ne $PID -and $_.Id -ne {own} -and $_.ProcessName -ne 'msedgewebview2' }})) {{
  try {{ $fvi = $p.MainModule.FileVersionInfo }} catch {{ continue }}
  $hay = ("$($fvi.FileDescription) $($fvi.ProductName) $($p.ProcessName)").ToLower()
  foreach ($w in $words) {{ if ($hay.Contains($w)) {{ $candidates += $p; break }} }}
}}
$distinct = @($candidates | Select-Object -ExpandProperty ProcessName -Unique)
if ($distinct.Count -eq 0) {{
  Write-Output 'NONE'
}} elseif ($distinct.Count -gt 1) {{
  Write-Output ('AMBIGUOUS:' + ($distinct -join ','))
}} else {{
  $candidates | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Output ('KILLED:' + $distinct[0])
}}"#,
        own = std::process::id()
    );
    match ps::run(&script, Duration::from_secs(15)) {
        Ok(out) => {
            if let Some(process) = out.strip_prefix("KILLED:") {
                CloseResult {
                    ok: true,
                    process_name: Some(process.into()),
                    reason: None,
                    candidates: None,
                }
            } else if let Some(list) = out.strip_prefix("AMBIGUOUS:") {
                CloseResult {
                    ok: false,
                    process_name: None,
                    reason: Some("ambiguous"),
                    candidates: Some(list.split(',').map(String::from).collect()),
                }
            } else {
                failure("not_found")
            }
        }
        Err(e) => {
            log::warn!("[fermeture] erreur : {e}");
            failure("error")
        }
    }
}

#[tauri::command]
pub async fn updates_close_related_app(pkg: NamedPackage) -> Result<CloseResult, String> {
    blocking(move || close_related_app(&pkg.name)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> String {
        let row = |a: &str, b: &str, c: &str, d: &str, e: &str| {
            format!(
                "{a:<25}{b:<22}{c:<12}{d:<12}{e}
"
            )
        };
        [
            row("Nom", "ID", "Version", "Disponible", "Source"),
            format!(
                "{}
",
                "-".repeat(79)
            ),
            row("Git", "Git.Git", "2.45.0", "2.46.1", "winget"),
            row("Éditeur de texte", "Foo.Editeur", "1.0", "1.1", "msstore"),
            "2 mises à niveau disponibles.
"
            .to_string(),
        ]
        .concat()
    }

    #[test]
    fn parses_winget_table_by_column_position() {
        let list = parse_winget_table("   - \r   \\ \r\n   | \r\n");
        assert!(list.is_empty());

        let list = parse_winget_table(&table());
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[1].name, "Éditeur de texte");
        assert_eq!(list[1].source, "msstore");
        assert_eq!(
            list[0],
            SoftwareUpdate {
                id: "Git.Git".into(),
                name: "Git".into(),
                current_version: "2.45.0".into(),
                available_version: "2.46.1".into(),
                source: "winget".into(),
                version_unknown: false,
            }
        );
    }

    #[test]
    fn hidden_programs_are_set_aside_not_lost() {
        let packages = parse_winget_table(&table());
        assert_eq!(packages.len(), 2);

        // Rien de masqué : tout est proposé.
        let (shown, hidden) = split_hidden(parse_winget_table(&table()), &[]);
        assert_eq!((shown.len(), hidden.len()), (2, 0));

        // Un programme masqué quitte la liste mais reste disponible à part, sans tenir compte de la casse.
        let (shown, hidden) = split_hidden(packages, &["git.git".to_string()]);
        assert_eq!(
            shown.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["Foo.Editeur"]
        );
        assert_eq!(
            hidden.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["Git.Git"]
        );

        // Un identifiant masqué qui n'a plus de mise à jour n'apparaît nulle part.
        let (shown, hidden) = split_hidden(
            parse_winget_table(&table()),
            &["Ancien.Programme".to_string()],
        );
        assert_eq!((shown.len(), hidden.len()), (2, 0));
    }

    #[test]
    fn unreadable_versions_are_flagged() {
        let row = |name: &str, id: &str, version: &str| {
            format!("{name:<25}{id:<22}{version:<12}{:<12}winget\r\n", "2.0")
        };
        let output = format!(
            "{}{}{}{}",
            table(),
            row("Battle.net", "Blizzard.BattleNet", "Unknown"),
            row("Ubisoft Connect", "Ubisoft.Connect", "< 1.2.3"),
            row("Sans version", "Foo.Bar", ""),
        );
        let list = parse_winget_table(&output);
        let flag = |id: &str| list.iter().find(|p| p.id == id).map(|p| p.version_unknown);
        assert_eq!(flag("Git.Git"), Some(false));
        assert_eq!(flag("Blizzard.BattleNet"), Some(true));
        assert_eq!(flag("Ubisoft.Connect"), Some(true));
        assert_eq!(flag("Foo.Bar"), Some(true));
    }

    #[test]
    fn parser_survives_garbage_and_empty_output() {
        assert!(parse_winget_table("").is_empty());
        assert!(parse_winget_table("Aucune mise à niveau disponible.").is_empty());
        assert!(parse_winget_table("--------------------------------\nx y z").is_empty());
    }

    #[test]
    fn package_ids_cannot_look_like_options() {
        assert!(is_valid_package_id("Microsoft.VisualStudioCode"));
        assert!(is_valid_package_id("7zip.7zip"));
        assert!(is_valid_package_id("Notepad++.Notepad++"));
        assert!(!is_valid_package_id("--force"));
        assert!(!is_valid_package_id("-h"));
        assert!(!is_valid_package_id(""));
        assert!(!is_valid_package_id("a b"));
        assert!(!is_valid_package_id("a'; calc; '"));
        assert!(!is_valid_package_id("au :"));
        assert!(is_valid_package_id(
            r"MSIXMicrosoft.WindowsTerminal_8wekyb3d8bbwe"
        ));
    }

    #[test]
    fn winget_restart_codes_are_successes_not_failures() {
        // « Redémarrez votre PC pour terminer l'installation » : l'installation a réussi.
        assert!(REBOOT_CODES.contains(&0x8A15_0109));
        assert!(REBOOT_CODES.contains(&0x8A15_010B));
        assert_eq!(detect_reboot(0x8A15_0109, ""), Some("system"));
        // Mais « installation échouée, redémarrez puis réessayez » (0x8A15010A) reste un échec.
        assert!(!REBOOT_CODES.contains(&0x8A15_010A));
    }

    #[test]
    fn reboot_is_detected() {
        assert_eq!(detect_reboot(3010, ""), Some("system"));
        assert_eq!(
            detect_reboot(0, "Veuillez redémarrer l'application pour finir"),
            Some("app")
        );
        assert_eq!(
            detect_reboot(0, "Un redémarrage de l'ordinateur est requis"),
            Some("system")
        );
        assert_eq!(
            detect_reboot(0, "Veuillez redémarrer votre ordinateur"),
            Some("system")
        );
        assert_eq!(detect_reboot(0, "Installation terminée"), None);
    }

    #[test]
    fn words_are_filtered() {
        assert_eq!(
            significant_words("Microsoft Visual Studio Code"),
            vec!["Microsoft", "Visual", "Code"]
        );
        assert_eq!(significant_words("Git 64-bit"), vec!["Git"]);
        assert!(significant_words("A B").is_empty());
    }

    #[test]
    fn closing_an_unknown_app_finds_nothing() {
        let res = close_related_app("Zzzqqqxx Nonexistent");
        assert!(!res.ok);
        assert_eq!(res.reason, Some("not_found"));
    }

    #[test]
    fn failed_install_reports_progress_and_writes_a_report() {
        use std::sync::{Arc, Mutex};

        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&events);
        let dir =
            std::env::temp_dir().join(format!("cleaner_pc_report_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let res = install_software_stream(
            vec![
                Package {
                    id: "Zzz.PaquetInexistant.Test".into(),
                    name: "Faux programme".into(),
                    current_version: None,
                    available_version: None,
                },
                Package {
                    id: "--force".into(),
                    name: "Option piégée".into(),
                    current_version: None,
                    available_version: None,
                },
            ],
            &move |p| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::to_string(&p).unwrap())
            },
            Some(&dir),
        );

        let events = events.lock().unwrap().clone();
        println!("événements : {events:#?}");
        let log_file = res.log_file.expect("un rapport doit être écrit");
        let report = std::fs::read_to_string(&log_file).unwrap();
        println!(
            "--- rapport ---
{report}"
        );
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(events.len(), 4, "installing + error pour chaque paquet");
        assert!(events[0].contains("\"installing\"") && events[1].contains("\"error\""));
        assert!(events[1].contains("\"reason\""));
        assert!(report.contains(
            "✗ Faux programme (Zzz.PaquetInexistant.Test) — Échec : Programme non reconnu"
        ));
        assert!(
            report.contains("identifiant invalide"),
            "l'option piégée doit être refusée"
        );
    }

    /// Sortie réelle de `winget list` pour un programme à jour : pas de colonne « Disponible ».
    fn up_to_date_row() -> String {
        format!(
            "{:<25}{:<22}{:<12}{}\r\n{}\r\n{:<25}{:<22}{:<12}{}\r\n",
            "Nom",
            "ID",
            "Version",
            "Source",
            "-".repeat(79),
            "Git",
            "Git.Git",
            "2.56.0.4",
            "winget"
        )
    }

    #[test]
    fn verification_reads_the_table_after_install() {
        // Toujours listé avec une version disponible : l'ancienne version est encore là.
        assert_eq!(
            classify_verification(&table(), "Git.Git", Some("2.45.0")),
            Verification::StillOutdated
        );
        // L'identifiant se compare sans tenir compte des majuscules.
        assert_eq!(
            classify_verification(&table(), "git.git", Some("2.45.0")),
            Verification::StillOutdated
        );
        // Trouvé, sans version plus récente (pas de colonne « Disponible ») : confirmé.
        // Régression : la colonne « Source » ne doit pas être prise pour une version disponible.
        assert_eq!(
            classify_verification(&up_to_date_row(), "Git.Git", Some("2.45.0")),
            Verification::Confirmed
        );
    }

    #[test]
    fn verification_gives_up_when_it_cannot_tell() {
        // Version installée jamais lisible : le programme sera toujours listé.
        let unknown = format!(
            "{}{:<25}{:<22}{:<12}{:<12}winget\r\n",
            table(),
            "Truc",
            "Truc.Truc",
            "Unknown",
            "2.0"
        );
        assert_eq!(
            classify_verification(&unknown, "Truc.Truc", Some("Unknown")),
            Verification::Unverifiable
        );
        assert_eq!(
            classify_verification(&table(), "Git.Git", Some("< 2.0")),
            Verification::Unverifiable
        );
        // Programme que le gestionnaire ne retrouve pas, ou sortie vide.
        for output in [
            "Aucun package installé ne correspond aux critères saisis.",
            "No installed package found matching input criteria.",
            "",
        ] {
            assert_eq!(
                classify_verification(output, "Foo.Bar", Some("1.0")),
                Verification::Unverifiable,
                "{output:?}"
            );
        }
    }

    #[test]
    fn installed_version_is_read_with_or_without_an_available_column() {
        // Sans mise à jour en attente : pas de colonne « Disponible » (vraie sortie).
        assert_eq!(
            installed_version(&up_to_date_row(), "Git.Git").as_deref(),
            Some("2.56.0.4")
        );
        assert_eq!(
            installed_version(&up_to_date_row(), "git.git").as_deref(),
            Some("2.56.0.4"),
            "casse ignorée"
        );
        // Avec une mise à jour en attente : la colonne « Version » reste la version installée.
        assert_eq!(
            installed_version(&table(), "Git.Git").as_deref(),
            Some("2.45.0")
        );
        // Programme absent, sortie vide ou texte seul.
        assert_eq!(installed_version(&table(), "Autre.Programme"), None);
        assert_eq!(installed_version("", "Git.Git"), None);
        assert_eq!(
            installed_version("Aucun package installé ne correspond.", "Git.Git"),
            None
        );
    }

    #[test]
    fn verification_never_installs() {
        let args = verify_args("Git.Git");
        assert_eq!(args[0], "list");
        assert!(!args.contains(&"upgrade") && !args.contains(&"install"));
        // À l'inverse, l'installation, elle, est bien une mise à jour.
        assert_eq!(install_args("Git.Git")[0], "upgrade");
    }

    #[test]
    fn unknown_versions_are_recognised() {
        for v in ["Unknown", "unknown", "Inconnu", "", "  ", "< 175.1.0.13416"] {
            assert!(is_version_unknown(v), "{v:?}");
        }
        for v in ["1.0", "2.45.0", "26.001.21789"] {
            assert!(!is_version_unknown(v), "{v:?}");
        }
    }

    /// À lancer à la main (`cargo test -- --ignored --nocapture`) : lit de vrais programmes.
    #[test]
    #[ignore]
    fn verification_on_this_machine() {
        let winget = find_winget().expect("winget");
        for (id, before) in [
            ("Git.Git", Some("2.0.0")),
            ("Blizzard.BattleNet", Some("Unknown")),
            ("Microsoft.VisualStudioCode", Some("1.0.0")),
            ("Zzz.PaquetInexistant", None),
        ] {
            println!("{id} -> {:?}", verify_install(&winget, id, before));
        }
    }

    /// Faux gestionnaire de paquets : `upgrade` attend `seconds` secondes (un programme lancé
    /// par lui attend aussi), `list` répond tout de suite.
    fn fake_winget(name: &str, seconds: u32, marker: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cleaner_pc_fake_{name}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("winget.cmd");
        let lines = [
            "@echo off".to_string(),
            format!(
                "if \"%1\"==\"upgrade\" ping -n {} {marker} >nul",
                seconds + 1
            ),
            "if \"%1\"==\"list\" goto list".to_string(),
            "exit /b 0".to_string(),
            ":list".to_string(),
            "echo Nom       ID             Version  Source".to_string(),
            "echo ----------------------------------------".to_string(),
            "echo Programme Test.Programme 2.0      winget".to_string(),
            "exit /b 0".to_string(),
        ];
        std::fs::write(&script, lines.join("\r\n")).unwrap();
        script
    }

    fn run_fake(winget: &Path, timings: &InstallTimings) -> (Vec<String>, StreamResult, Duration) {
        use std::sync::{Arc, Mutex};
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&events);
        let dir = winget.parent().unwrap().to_path_buf();
        let started = std::time::Instant::now();
        let res = install_with(
            vec![Package {
                id: "Test.Programme".into(),
                name: "Programme de test".into(),
                current_version: Some("1.0".into()),
                available_version: Some("2.0".into()),
            }],
            Some(winget.to_path_buf()),
            timings,
            &move |p| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::to_string(&p).unwrap())
            },
            Some(&dir),
        );
        let events = events.lock().unwrap().clone();
        (events, res, started.elapsed())
    }

    #[test]
    fn a_long_installation_warns_once_then_succeeds() {
        let fake = fake_winget("slow", 4, "127.0.0.7");
        let timings = InstallTimings {
            timeout: Duration::from_secs(30),
            slow_after: Duration::from_secs(1),
        };
        let (events, res, _) = run_fake(&fake, &timings);
        println!("{events:#?}");
        let slow = events
            .iter()
            .filter(|e| e.contains("\"slow\":true"))
            .count();
        assert_eq!(slow, 1, "un seul avertissement « installation longue »");
        assert!(events.first().unwrap().contains("\"installing\""));
        assert!(
            events.last().unwrap().contains("\"status\":\"ok\""),
            "{events:?}"
        );
        assert!(
            events
                .last()
                .unwrap()
                .contains("\"verification\":\"confirmed\""),
            "{events:?}"
        );

        // Une installation réussie laisse aussi un rapport, avec les trois versions.
        let report =
            std::fs::read_to_string(res.log_file.expect("un rapport même en cas de succès"))
                .unwrap();
        println!("{report}");
        assert!(report.contains("✓ Programme de test (Test.Programme) — Mise à jour confirmée"));
        assert!(report.contains("Version avant : 1.0 · attendue : 2.0 · relue après : 2.0"));
        assert!(report.contains("Résumé : 1 mise à jour confirmée"));
        let _ = std::fs::remove_dir_all(fake.parent().unwrap());
    }

    #[test]
    fn a_quick_installation_never_warns() {
        let fake = fake_winget("quick", 1, "127.0.0.6");
        let timings = InstallTimings {
            timeout: Duration::from_secs(30),
            slow_after: Duration::from_secs(20),
        };
        let (events, _, _) = run_fake(&fake, &timings);
        assert!(!events.iter().any(|e| e.contains("slow")), "{events:?}");
        assert!(events.last().unwrap().contains("\"status\":\"ok\""));
        let _ = std::fs::remove_dir_all(fake.parent().unwrap());
    }

    #[test]
    fn an_installation_that_never_ends_is_stopped_cleanly_and_explained() {
        let marker = "127.0.0.5";
        let fake = fake_winget("stuck", 60, marker);
        let timings = InstallTimings {
            timeout: Duration::from_secs(3),
            slow_after: Duration::from_secs(1),
        };
        let (events, res, elapsed) = run_fake(&fake, &timings);
        println!("{events:#?}");
        assert!(
            elapsed < Duration::from_secs(20),
            "doit s'arrêter vite : {elapsed:?}"
        );

        let last = events.last().unwrap();
        assert!(last.contains("\"status\":\"error\""), "{last}");
        assert!(
            last.contains("trop de temps"),
            "message clair attendu : {last}"
        );
        assert!(last.contains("\"kind\":\"retry_later\""), "{last}");
        let report = std::fs::read_to_string(res.log_file.expect("un rapport")).unwrap();
        assert!(report.contains("Programme de test"));

        // Rien ne tourne encore : le programme lancé par l'installation a été arrêté avec elle.
        std::thread::sleep(Duration::from_secs(1));
        let out = ps::run(
            &format!(
                "(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object {{ $_.CommandLine -like '*{marker}*' }} | Measure-Object).Count"
            ),
            Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(out, "0", "l'installation a laissé un programme en cours");
        let _ = std::fs::remove_dir_all(fake.parent().unwrap());
    }

    #[test]
    fn software_scan_runs_for_real() {
        if find_winget().is_none() {
            eprintln!("gestionnaire de paquets absent de cette machine : test ignoré");
            return;
        }
        let res = get_software(&[]);
        println!(
            "ok={} {} programmes, erreur={:?}",
            res.ok,
            res.data.len(),
            res.error
        );
        for p in &res.data {
            println!(
                "  {} {} -> {}",
                p.id, p.current_version, p.available_version
            );
        }
        assert!(res.ok);
    }
}
