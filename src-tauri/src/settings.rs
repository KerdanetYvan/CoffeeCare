//! Paramètres de l'application : version, lancement avec Windows, ouverture des journaux.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInfo {
    version: String,
    open_at_login: bool,
}

#[derive(Serialize)]
pub struct Ack {
    ok: bool,
}

#[tauri::command]
pub fn settings_get_info(app: AppHandle) -> Result<SettingsInfo, String> {
    Ok(SettingsInfo {
        version: app.package_info().version.to_string(),
        open_at_login: app.autolaunch().is_enabled().map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub fn settings_set_login_item(app: AppHandle, open_at_login: bool) -> Result<Ack, String> {
    let launcher = app.autolaunch();
    let res = if open_at_login {
        launcher.enable()
    } else {
        launcher.disable()
    };
    res.map_err(|e| e.to_string())?;
    Ok(Ack { ok: true })
}

/// Ouvre un rapport (.log) du dossier de journaux de l'application, et rien d'autre.
/// Renvoie un message d'erreur, ou une chaîne vide si tout s'est bien passé.
#[tauri::command]
pub fn shell_open_log(app: AppHandle, path: String) -> String {
    let logs_dir = match app.path().app_data_dir().map(|d| d.join("logs")) {
        Ok(d) => d,
        Err(e) => return e.to_string(),
    };
    let (Ok(logs_dir), Ok(file)) = (
        logs_dir.canonicalize(),
        std::path::Path::new(&path).canonicalize(),
    ) else {
        return "Fichier introuvable".into();
    };
    let is_log = file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("log"));
    if !file.starts_with(&logs_dir) || !is_log {
        return "Ce fichier ne peut pas être ouvert".into();
    }
    match app.opener().open_path(file.to_string_lossy(), None::<&str>) {
        Ok(()) => String::new(),
        Err(e) => e.to_string(),
    }
}
