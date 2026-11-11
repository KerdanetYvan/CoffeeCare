//! Mises à jour : logiciels (via le gestionnaire de paquets de Windows) et pilotes.
//!
//! Le gestionnaire est lancé directement avec une liste d'arguments, sans passer par
//! un interpréteur : un identifiant de programme ne peut pas devenir une commande.
//! Les rapports d'échec sont écrits dans `<données de l'app>\logs`.

use crate::{proc, ps};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const SOURCE_UPDATE_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const ELEVATED_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const DRIVER_SCAN_TIMEOUT: Duration = Duration::from_secs(60);
const DRIVER_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const GENERIC_ERROR: &str = "Une erreur est survenue, réessayez";
const NO_UPDATER_ERROR: &str =
    "Le gestionnaire de mises à jour de Windows est introuvable sur ce PC";

/// Codes Windows « installé avec succès, redémarrage nécessaire ».
const REBOOT_CODES: [i64; 2] = [3010, 1641];

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
    let mut cmd = proc::hidden(&winget.to_string_lossy());
    cmd.args(args);
    match proc::capture(cmd, timeout) {
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

    // Position (en caractères) du début de chaque mot de l'en-tête.
    let header: Vec<char> = lines[sep - 1].chars().collect();
    let mut cols: Vec<usize> = Vec::new();
    let mut in_word = false;
    for (i, c) in header.iter().enumerate() {
        if c.is_whitespace() {
            in_word = false;
        } else if !in_word {
            cols.push(i);
            in_word = true;
        }
    }
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
        packages.push(SoftwareUpdate {
            name: if name.is_empty() { id.clone() } else { name },
            id,
            current_version: if version.is_empty() {
                "Inconnu".into()
            } else {
                version
            },
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

fn get_software() -> ListResult<SoftwareUpdate> {
    let Some(winget) = find_winget() else {
        return ListResult::err(NO_UPDATER_ERROR);
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
            ListResult::ok(packages)
        }
        Err(e) => {
            log::warn!("[mises à jour] analyse échouée : {e}");
            ListResult::err(GENERIC_ERROR)
        }
    }
}

#[tauri::command]
pub async fn updates_get_software() -> Result<ListResult<SoftwareUpdate>, String> {
    blocking(get_software).await
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

static REASON_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (
            r"(?i)fichiers.{0,80}actuellement utilis",
            "Fermez l'application, puis réessayez",
        ),
        (
            r"(?i)technologie d.installation différente",
            "Réinstallation manuelle requise",
        ),
        (
            r"(?i)code de hachage.{0,40}ne correspond pas",
            "Problème de téléchargement — réessayez",
        ),
        (
            r"(?i)aucune mise à (?:niveau|upgrade) applicable",
            "Pas de version compatible pour votre système",
        ),
        (
            r"(?i)ne s.applique pas à votre système",
            "Pas de version compatible pour votre système",
        ),
        (
            r"(?i)aucun package installé ne correspond",
            "Programme non reconnu",
        ),
        (
            r"(?i)impossible de déterminer le numéro de version",
            "Version non identifiable — mise à jour impossible",
        ),
        (r"(?i)application not found", "Application introuvable"),
        (
            r"(?i)une erreur inattendue s.est produite",
            "Erreur interne — réessayez",
        ),
        (r"(?i)code de sortie.*3221226525", NEEDS_ADMIN),
        (
            r"(?i)code de sortie.*6\b",
            "Fermez l'application avant de mettre à jour",
        ),
    ]
    .into_iter()
    .map(|(pattern, message)| (Regex::new(pattern).unwrap(), message))
    .collect()
});

/// Cette phrase exacte déclenche le bouton « réessayer avec autorisation » côté interface.
const NEEDS_ADMIN: &str = "Droits administrateur probablement requis";

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

fn extract_reason(output: &str, code: i64) -> String {
    for (pattern, message) in REASON_PATTERNS.iter() {
        if pattern.is_match(output) {
            return (*message).into();
        }
    }
    if let Some(last) = output
        .lines()
        .map(str::trim)
        .rfind(|l| l.chars().count() > 5 && !is_spinner(l))
    {
        return last.chars().take(120).collect();
    }
    match code {
        2316632070 => "L'installeur a échoué",
        2316632337 => "Fichiers en cours d'utilisation — fermez l'application",
        2316632081 => "Vérification de sécurité échouée",
        2147746293 => "Application introuvable",
        _ => GENERIC_ERROR,
    }
    .into()
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

fn write_report(dir: Option<&Path>, lines: &[String]) -> Option<String> {
    let file = dir?.join(format!(
        "update-{}.log",
        chrono::Local::now().format("%Y-%m-%dT%H-%M-%S")
    ));
    std::fs::write(
        &file,
        lines.join(
            "
",
        ),
    )
    .ok()?;
    log::info!("[mises à jour] rapport écrit : {}", file.display());
    Some(file.to_string_lossy().into_owned())
}

fn report_header() -> String {
    format!(
        "=== Rapport de mise à jour — {} ===",
        chrono::Local::now().format("%d/%m/%Y %H:%M:%S")
    )
}

fn report_failure(name: &str, id: &str, label: &str, code: i64, output: &str) -> String {
    let cleaned = clean_winget_output(output);
    let body = if cleaned.is_empty() {
        "  (aucune sortie capturée)".to_string()
    } else {
        cleaned
            .iter()
            .map(|l| format!("  {l}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!("✗ {name} ({id}) — {label} (code de sortie : {code})\n{body}")
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reboot: Option<&'static str>,
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
    let winget = find_winget();
    let mut lines = vec![
        report_header(),
        format!(
            "Gestionnaire : {}",
            winget
                .as_ref()
                .map_or("introuvable".into(), |p| p.display().to_string())
        ),
        String::new(),
    ];
    let mut has_errors = false;

    for Package { id, name } in packages {
        emit(Progress {
            id: id.clone(),
            status: "installing",
            reason: None,
            reboot: None,
        });

        let Some(winget) = winget.as_ref().filter(|_| is_valid_package_id(&id)) else {
            has_errors = true;
            let why = if winget.is_none() {
                "gestionnaire introuvable"
            } else {
                "identifiant invalide"
            };
            lines.push(format!("✗ {name} ({id})\n  {why}\n"));
            emit(Progress {
                id,
                status: "error",
                reason: Some(GENERIC_ERROR.into()),
                reboot: None,
            });
            continue;
        };

        let (code, captured) = match run_winget(winget, &install_args(&id), INSTALL_TIMEOUT) {
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
            let note = match reboot {
                Some("system") => " (redémarrage PC requis)",
                Some(_) => " (redémarrage logiciel requis)",
                None => "",
            };
            lines.push(format!("✓ {name} ({id}) — Mis à jour{note}"));
            emit(Progress {
                id,
                status: "ok",
                reason: None,
                reboot,
            });
        } else {
            has_errors = true;
            lines.push(report_failure(&name, &id, "Échec", code, &captured));
            emit(Progress {
                id,
                status: "error",
                reason: Some(extract_reason(&captured, code)),
                reboot: None,
            });
        }
    }

    StreamResult {
        log_file: if has_errors {
            write_report(report_dir, &lines)
        } else {
            None
        },
    }
}

#[tauri::command]
pub async fn updates_install_software_stream(
    app: AppHandle,
    packages: Vec<Package>,
) -> Result<StreamResult, String> {
    blocking(move || {
        let dir = logs_dir(&app);
        install_software_stream(
            packages,
            &|p| {
                let _ = app.emit("updates:swProgress", p);
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
    reboot: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_file: Option<String>,
}

fn refused(reason: &str) -> ElevatedResult {
    ElevatedResult {
        ok: false,
        reason: Some(reason.into()),
        reboot: None,
        log_file: None,
    }
}

fn install_elevated(app: &AppHandle, pkg: Package) -> ElevatedResult {
    let Some(winget) = find_winget() else {
        return refused(NO_UPDATER_ERROR);
    };
    if !is_valid_package_id(&pkg.id) {
        return refused(GENERIC_ERROR);
    }
    let Package { id, name } = pkg;

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
        return refused("Autorisation refusée ou mise à jour annulée");
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
    if ok {
        return ElevatedResult {
            ok: true,
            reason: None,
            reboot: detect_reboot(code, &output),
            log_file: None,
        };
    }

    let log_file = write_report(
        logs_dir(app).as_deref(),
        &[
            report_header(),
            String::new(),
            report_failure(&name, &id, "Échec admin", code, &output),
        ],
    );
    // Les droits sont déjà élevés : si le diagnostic parle encore de droits, c'est que
    // l'installeur a planté, le plus souvent parce que le programme est resté ouvert.
    let mut reason = extract_reason(&output, code);
    if reason == NEEDS_ADMIN {
        reason = format!(
            "Le programme d'installation a planté — fermez complètement {name} (icône dans la barre des tâches incluse), puis réessayez"
        );
    }
    ElevatedResult {
        ok: false,
        reason: Some(reason),
        reboot: None,
        log_file,
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
            }
        );
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
    fn failure_reasons_are_friendly() {
        let r = |o: &str, c| extract_reason(o, c);
        assert_eq!(
            r(
                "Les fichiers sont actuellement utilisés par un autre processus",
                1
            ),
            "Fermez l'application, puis réessayez"
        );
        assert_eq!(
            r("Code de sortie de l'installeur : 3221226525", 1),
            NEEDS_ADMIN
        );
        assert_eq!(
            r("Aucun package installé ne correspond", 1),
            "Programme non reconnu"
        );
        assert_eq!(
            r("", 2316632337),
            "Fichiers en cours d'utilisation — fermez l'application"
        );
        assert_eq!(r("", 42), GENERIC_ERROR);
        assert_eq!(
            r("-\n\\\nDernière ligne utile ici", 1),
            "Dernière ligne utile ici"
        );
        for (_, message) in REASON_PATTERNS.iter() {
            assert!(
                !message.to_lowercase().contains("winget"),
                "jargon visible : {message}"
            );
        }
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
                },
                Package {
                    id: "--force".into(),
                    name: "Option piégée".into(),
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
        assert!(report.contains("✗ Faux programme (Zzz.PaquetInexistant.Test)"));
        assert!(
            report.contains("identifiant invalide"),
            "l'option piégée doit être refusée"
        );
    }

    #[test]
    fn software_scan_runs_for_real() {
        let res = get_software();
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
