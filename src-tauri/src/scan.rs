//! Analyse et nettoyage des dossiers temporaires.

use crate::proc;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const ELEVATION_TIMEOUT: Duration = Duration::from_secs(120);

struct TempDir {
    path: PathBuf,
    label: &'static str,
    /// Programme qui peut verrouiller le dossier : (nom du processus, nom affiché).
    app: Option<(&'static str, &'static str)>,
}

fn env_path(var: &str, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(fallback)
}

/// Liste fermée des dossiers que l'application sait nettoyer.
fn temp_dirs() -> Vec<TempDir> {
    let home = env_path("USERPROFILE", || PathBuf::from("C:\\Users\\Default"));
    let sys_root = env_path("SystemRoot", || PathBuf::from("C:\\Windows"));
    let local = env_path("LOCALAPPDATA", || home.join("AppData").join("Local"));
    let roaming = env_path("APPDATA", || home.join("AppData").join("Roaming"));

    let d = |path: PathBuf, label, app| TempDir { path, label, app };
    vec![
        d(
            std::env::temp_dir(),
            "Fichiers temporaires utilisateur",
            None,
        ),
        d(sys_root.join("Temp"), "Fichiers temporaires Windows", None),
        d(sys_root.join("Logs"), "Journaux Windows", None),
        d(
            sys_root.join("System32").join("LogFiles"),
            "Journaux système (System32)",
            None,
        ),
        d(sys_root.join("Minidump"), "Fichiers Minidump", None),
        d(
            local.join("Microsoft").join("Windows").join("WER"),
            "Rapports d'erreurs Windows (WER)",
            None,
        ),
        d(
            sys_root.join("SoftwareDistribution").join("Download"),
            "Téléchargements Windows Update",
            None,
        ),
        d(
            local.join("Microsoft").join("Windows").join("INetCache"),
            "Cache Internet Explorer / Edge",
            None,
        ),
        d(
            local
                .join("Microsoft")
                .join("Edge")
                .join("User Data")
                .join("Default")
                .join("Cache"),
            "Cache Microsoft Edge",
            Some(("msedge.exe", "Microsoft Edge")),
        ),
        d(
            local
                .join("Google")
                .join("Chrome")
                .join("User Data")
                .join("Default")
                .join("Cache"),
            "Cache Google Chrome",
            Some(("chrome.exe", "Google Chrome")),
        ),
        d(
            local.join("Mozilla").join("Firefox").join("Profiles"),
            "Profils Firefox",
            Some(("firefox.exe", "Firefox")),
        ),
        d(
            local.join("Discord").join("Cache"),
            "Cache Discord",
            Some(("Discord.exe", "Discord")),
        ),
        d(
            roaming.join("Spotify").join("Browser").join("Cache"),
            "Cache Spotify",
            Some(("Spotify.exe", "Spotify")),
        ),
        d(
            roaming.join("Code").join("Cache"),
            "Cache VS Code",
            Some(("Code.exe", "VS Code")),
        ),
        d(
            local.join("Microsoft").join("Teams").join("Cache"),
            "Cache Microsoft Teams",
            Some(("ms-teams.exe", "Microsoft Teams")),
        ),
    ]
}

fn normalize(p: &Path) -> String {
    p.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

/// Un dossier « admin » est un dossier en lecture seule (même test qu'avant la migration).
fn is_read_only(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.permissions().readonly())
        .unwrap_or(true)
}

/// Taille et nombre de fichiers, sans suivre les liens symboliques.
fn dir_info(root: &Path) -> (u64, u64) {
    let (mut size, mut count) = (0u64, 0u64);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file()
                && let Ok(meta) = entry.metadata()
            {
                size += meta.len();
                count += 1;
            }
        }
    }
    (size, count)
}

fn running_processes() -> String {
    proc::hidden("tasklist")
        .args(["/NH", "/FO", "CSV"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempDirInfo {
    path: String,
    label: String,
    requires_admin: bool,
    size_bytes: u64,
    file_count: u64,
    locked_by_process: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    ok: bool,
    data: Vec<TempDirInfo>,
    running_apps: Vec<String>,
}

fn scan() -> ScanResult {
    let tasklist = running_processes();
    let mut data = Vec::new();
    let mut running_apps: Vec<String> = Vec::new();

    for dir in temp_dirs() {
        if !dir.path.is_dir() {
            continue;
        }
        let (size_bytes, file_count) = dir_info(&dir.path);
        let locked_by_process = dir
            .app
            .filter(|(process, _)| tasklist.contains(&process.to_lowercase()))
            .map(|(_, name)| name.to_string());
        if let Some(name) = &locked_by_process
            && !running_apps.contains(name)
        {
            running_apps.push(name.clone());
        }
        data.push(TempDirInfo {
            path: dir.path.to_string_lossy().into_owned(),
            label: dir.label.into(),
            requires_admin: is_read_only(&dir.path),
            size_bytes,
            file_count,
            locked_by_process,
        });
    }
    ScanResult {
        ok: true,
        data,
        running_apps,
    }
}

#[tauri::command]
pub async fn scan_get_temp_dirs() -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|e| e.to_string())
}

// ─── Nettoyage ──────────────────────────────────────────────────────────────

#[derive(Default)]
struct Deleted {
    freed_bytes: u64,
    deleted_count: u64,
    error_count: u64,
}

/// Supprime le contenu d'un dossier (pas le dossier lui-même).
fn delete_contents(dir: &Path) -> Deleted {
    let mut out = Deleted::default();
    let Ok(entries) = fs::read_dir(dir) else {
        out.error_count += 1;
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            out.error_count += 1;
            continue;
        };
        let size = if ft.is_file() {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };
        let res = if ft.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match res {
            Ok(()) => {
                out.freed_bytes += size;
                out.deleted_count += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => out.error_count += 1,
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCleanResult {
    path: String,
    status: &'static str,
    freed_bytes: u64,
    deleted_count: u64,
    error_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    ok: bool,
    freed_bytes: u64,
    deleted_count: u64,
    error_count: u64,
    dirs: Vec<DirCleanResult>,
}

fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Vide les dossiers via un PowerShell lancé en administrateur. Windows demande
/// l'autorisation à l'utilisateur. Le script est transmis encodé : aucun fichier
/// intermédiaire que quelqu'un d'autre pourrait modifier avant son exécution.
fn delete_elevated(paths: &[String]) -> bool {
    let script: String = paths
        .iter()
        .map(|p| {
            format!(
                "Get-ChildItem -LiteralPath '{}' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue\n",
                ps_quote(p)
            )
        })
        .collect();
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);

    let launcher = format!(
        "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}' -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop"
    );
    let mut cmd = proc::hidden("powershell");
    cmd.args(["-NoProfile", "-Command", &launcher]);
    matches!(proc::status_with_timeout(cmd, ELEVATION_TIMEOUT), Ok(Some(s)) if s.success())
}

fn clean(requested: Vec<String>) -> CleanResult {
    let allowed: Vec<String> = temp_dirs().iter().map(|d| normalize(&d.path)).collect();

    let mut total = Deleted::default();
    let mut dirs = Vec::new();
    let mut elevated: Vec<String> = Vec::new();

    for path in requested {
        // Seuls les dossiers connus de l'application peuvent être vidés.
        if !allowed.contains(&normalize(Path::new(&path))) {
            total.error_count += 1;
            dirs.push(DirCleanResult {
                path,
                status: "denied",
                freed_bytes: 0,
                deleted_count: 0,
                error_count: 1,
            });
            continue;
        }
        if is_read_only(Path::new(&path)) {
            elevated.push(path);
            continue;
        }
        let res = delete_contents(Path::new(&path));
        if res.error_count > 0 && res.deleted_count == 0 {
            // Rien n'a pu être supprimé : on retente avec les droits administrateur.
            elevated.push(path);
            continue;
        }
        total.freed_bytes += res.freed_bytes;
        total.deleted_count += res.deleted_count;
        total.error_count += res.error_count;
        dirs.push(DirCleanResult {
            path,
            status: if res.error_count == 0 {
                "ok"
            } else {
                "partial"
            },
            freed_bytes: res.freed_bytes,
            deleted_count: res.deleted_count,
            error_count: res.error_count,
        });
    }

    if !elevated.is_empty() {
        let ok = delete_elevated(&elevated);
        for path in elevated {
            if ok {
                total.deleted_count += 1;
            } else {
                total.error_count += 1;
            }
            dirs.push(DirCleanResult {
                path,
                status: if ok { "ok" } else { "denied" },
                freed_bytes: 0,
                deleted_count: u64::from(ok),
                error_count: u64::from(!ok),
            });
        }
    }

    CleanResult {
        ok: total.error_count == 0,
        freed_bytes: total.freed_bytes,
        deleted_count: total.deleted_count,
        error_count: total.error_count,
        dirs,
    }
}

#[tauri::command]
pub async fn clean_delete_dirs(paths: Vec<String>) -> Result<CleanResult, String> {
    tauri::async_runtime::spawn_blocking(move || clean(paths))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_finds_user_temp() {
        let res = scan();
        assert!(
            res.data
                .iter()
                .any(|d| d.label == "Fichiers temporaires utilisateur")
        );
    }

    #[test]
    fn clean_refuses_unknown_paths() {
        let res = clean(vec!["C:\\Windows\\System32".into(), "C:\\".into()]);
        assert!(!res.ok);
        assert_eq!(res.error_count, 2);
        assert!(res.dirs.iter().all(|d| d.status == "denied"));
    }

    #[test]
    fn delete_contents_removes_files_and_folders() {
        let root = std::env::temp_dir().join(format!("cleaner_pc_test_{}", std::process::id()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.txt"), b"12345").unwrap();
        fs::write(root.join("sub").join("b.txt"), b"1").unwrap();
        let res = delete_contents(&root);
        assert_eq!(
            (res.deleted_count, res.error_count, res.freed_bytes),
            (2, 0, 5)
        );
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        fs::remove_dir(&root).unwrap();
    }
}
