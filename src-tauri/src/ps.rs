//! Exécution de scripts PowerShell, normaux ou en administrateur.
//!
//! Les scripts sont transmis encodés (`-EncodedCommand`) : aucun fichier
//! intermédiaire qu'un autre programme pourrait modifier avant l'exécution.
//! Toute valeur venant de l'interface doit passer par [`quote`].

use crate::proc;
use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Sortie en UTF-8 (accents des noms de périphériques) et pas de barre de progression.
const PRELUDE: &str = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n";

/// Limite de longueur d'une ligne de commande Windows, avec une marge.
const MAX_COMMAND_LINE: usize = 30_000;

/// Échappe un texte pour l'insérer entre apostrophes dans PowerShell.
/// PowerShell traite aussi les apostrophes typographiques comme des apostrophes.
pub fn quote(s: &str) -> String {
    let escaped: String = s
        .chars()
        .map(|c| match c {
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => format!("{c}{c}"),
            _ => c.to_string(),
        })
        .collect();
    format!("'{escaped}'")
}

fn encode(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

fn clean_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string()
}

/// Exécute un script et renvoie ce qu'il affiche.
pub fn run(script: &str, timeout: Duration) -> Result<String, String> {
    let mut cmd = proc::hidden("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &encode(&format!("{PRELUDE}{script}")),
    ]);
    match proc::capture(cmd, timeout) {
        Ok(Some(c)) if c.status.success() => Ok(clean_output(&c.stdout)),
        Ok(Some(c)) => Err(format!("PowerShell a échoué ({:?})", c.status.code())),
        Ok(None) => Err("délai dépassé".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Exécute un script avec les droits administrateur (Windows demande l'autorisation).
/// `true` si l'utilisateur a accepté et que le script s'est terminé.
pub fn run_elevated(script: &str, timeout: Duration) -> bool {
    let launcher = format!(
        "Start-Process powershell -ArgumentList '-NoProfile','-EncodedCommand','{}' -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop",
        encode(script)
    );
    if launcher.len() > MAX_COMMAND_LINE {
        return false;
    }
    let mut cmd = proc::hidden("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &launcher]);
    matches!(proc::status_with_timeout(cmd, timeout), Ok(Some(s)) if s.success())
}

fn result_file() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("cleaner_pc_{}_{nanos}.txt", std::process::id()))
}

/// Comme [`run_elevated`], pour un script qui doit renvoyer un texte : `build`
/// reçoit le chemin (déjà entre apostrophes) du fichier où le script doit l'écrire.
pub fn run_elevated_with_result(
    timeout: Duration,
    build: impl FnOnce(&str) -> String,
) -> (bool, String) {
    let file = result_file();
    let script = build(&quote(&file.to_string_lossy()));
    let ok = run_elevated(&script, timeout);
    let text = std::fs::read(&file)
        .map(|b| clean_output(&b))
        .unwrap_or_default();
    let _ = std::fs::remove_file(&file);
    (ok, text)
}

/// Découpe la sortie JSON de `ConvertTo-Json` (objet seul, tableau ou vide) en lignes.
pub fn json_rows(output: &str) -> Result<Vec<Value>, String> {
    let text = output.trim().trim_start_matches('\u{feff}');
    if text.is_empty() || text == "null" {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(text).map_err(|e| e.to_string())? {
        Value::Array(items) => Ok(items),
        Value::Null => Ok(Vec::new()),
        other => Ok(vec![other]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_doubles_every_kind_of_apostrophe() {
        assert_eq!(quote("a'b"), "'a''b'");
        assert_eq!(quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
        assert_eq!(quote("x'; calc; '"), "'x''; calc; '''");
    }

    #[test]
    fn json_rows_handles_all_shapes() {
        assert!(json_rows("").unwrap().is_empty());
        assert!(json_rows("null").unwrap().is_empty());
        assert!(json_rows("[]").unwrap().is_empty());
        assert_eq!(json_rows(r#"{"a":1}"#).unwrap().len(), 1);
        assert_eq!(json_rows(r#"[{"a":1},{"a":2}]"#).unwrap().len(), 2);
        assert!(json_rows("pas du json").is_err());
    }

    #[test]
    fn run_returns_utf8_output() {
        let out = run("Write-Output 'Périphérique é'", Duration::from_secs(20)).unwrap();
        assert_eq!(out, "Périphérique é");
    }

    #[test]
    fn run_times_out() {
        assert!(run("Start-Sleep 30", Duration::from_secs(1)).is_err());
    }
}
