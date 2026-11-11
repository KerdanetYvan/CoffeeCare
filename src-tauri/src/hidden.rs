//! Programmes que l'utilisateur ne veut plus se voir proposer dans les mises à jour.
//!
//! La liste (des identifiants, rien d'autre) est gardée dans le dossier de données de
//! l'application. Un fichier absent, vide ou abîmé donne une liste vide : l'analyse des
//! mises à jour ne doit jamais échouer à cause de lui.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;
use std::sync::Mutex;

const FILE_NAME: &str = "hidden-updates.json";

/// Évite que deux modifications simultanées s'écrasent.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    #[serde(default)]
    hidden: Vec<String>,
}

/// Les identifiants se comparent sans tenir compte des majuscules.
pub fn contains(ids: &[String], id: &str) -> bool {
    ids.iter().any(|h| h.eq_ignore_ascii_case(id))
}

fn read(dir: &Path) -> Vec<String> {
    let path = dir.join(FILE_NAME);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Stored>(text.trim_start_matches('\u{feff}'))
            .map(|s| s.hidden)
            .unwrap_or_else(|e| {
                log::warn!("liste des programmes masqués illisible, ignorée : {e}");
                Vec::new()
            }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            log::warn!("liste des programmes masqués inaccessible : {e}");
            Vec::new()
        }
    }
}

/// Écrit dans un fichier temporaire puis le renomme : une coupure en plein milieu ne laisse
/// jamais un fichier à moitié écrit.
fn write(dir: &Path, ids: &[String]) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(&Stored {
        hidden: ids.to_vec(),
    })
    .map_err(io::Error::other)?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, dir.join(FILE_NAME))
}

fn locked<T>(f: impl FnOnce() -> T) -> T {
    // Un verrou empoisonné reste utilisable : les données sont relues depuis le fichier.
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

pub fn load(dir: &Path) -> Vec<String> {
    locked(|| read(dir))
}

/// Masque un programme et renvoie la liste à jour.
pub fn hide(dir: &Path, id: &str) -> io::Result<Vec<String>> {
    locked(|| {
        let mut ids = read(dir);
        if !contains(&ids, id) {
            ids.push(id.to_string());
            write(dir, &ids)?;
        }
        Ok(ids)
    })
}

/// Propose de nouveau un programme et renvoie la liste à jour.
pub fn unhide(dir: &Path, id: &str) -> io::Result<Vec<String>> {
    locked(|| {
        let mut ids = read(dir);
        let before = ids.len();
        ids.retain(|h| !h.eq_ignore_ascii_case(id));
        if ids.len() != before {
            write(dir, &ids)?;
        }
        Ok(ids)
    })
}

/// Propose de nouveau tous les programmes masqués.
pub fn unhide_all(dir: &Path) -> io::Result<Vec<String>> {
    locked(|| {
        write(dir, &[])?;
        Ok(Vec::new())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dossier de test propre à chaque appel.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cleaner_pc_hidden_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_means_nothing_is_hidden() {
        let dir = temp_dir("missing");
        assert!(load(&dir).is_empty());
    }

    #[test]
    fn hide_then_unhide_round_trip() {
        let dir = temp_dir("roundtrip");
        assert_eq!(hide(&dir, "Git.Git").unwrap(), vec!["Git.Git"]);
        assert_eq!(hide(&dir, "Docker.DockerDesktop").unwrap().len(), 2);
        // La liste survit à un « redémarrage » : elle est relue depuis le fichier.
        assert_eq!(load(&dir), vec!["Git.Git", "Docker.DockerDesktop"]);

        assert_eq!(
            unhide(&dir, "Git.Git").unwrap(),
            vec!["Docker.DockerDesktop"]
        );
        assert_eq!(load(&dir), vec!["Docker.DockerDesktop"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hiding_twice_or_in_another_case_adds_one_entry() {
        let dir = temp_dir("twice");
        hide(&dir, "Git.Git").unwrap();
        hide(&dir, "Git.Git").unwrap();
        hide(&dir, "git.git").unwrap();
        assert_eq!(load(&dir), vec!["Git.Git"]);
        // Et on peut le proposer de nouveau quelle que soit la casse.
        assert!(unhide(&dir, "GIT.GIT").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unhiding_something_not_hidden_changes_nothing() {
        let dir = temp_dir("absent");
        hide(&dir, "Git.Git").unwrap();
        assert_eq!(unhide(&dir, "Autre.Programme").unwrap(), vec!["Git.Git"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unhide_all_empties_the_list() {
        let dir = temp_dir("all");
        hide(&dir, "A.A").unwrap();
        hide(&dir, "B.B").unwrap();
        assert!(unhide_all(&dir).unwrap().is_empty());
        assert!(load(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn damaged_file_is_ignored_and_can_be_replaced() {
        let dir = temp_dir("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), "{ pas du json").unwrap();
        assert!(load(&dir).is_empty());
        assert_eq!(hide(&dir, "Git.Git").unwrap(), vec!["Git.Git"]);
        assert_eq!(load(&dir), vec!["Git.Git"]);

        // Fichier vide ou avec un BOM : même chose, sans échec.
        std::fs::write(dir.join(FILE_NAME), "").unwrap();
        assert!(load(&dir).is_empty());
        std::fs::write(dir.join(FILE_NAME), "\u{feff}{\"hidden\":[\"X.Y\"]}").unwrap();
        assert_eq!(load(&dir), vec!["X.Y"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let dir = temp_dir("tmp");
        hide(&dir, "Git.Git").unwrap();
        assert!(!dir.join(format!("{FILE_NAME}.tmp")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
