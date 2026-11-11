//! Rapport écrit à la fin de chaque session de mise à jour, réussites comme échecs.
//!
//! Il sert à comprendre après coup ce qui s'est passé, et à comparer avec l'analyse suivante :
//! pour chaque programme, la version avant, la version attendue et la version relue après.
//! Les 30 derniers rapports sont conservés dans le dossier de journaux, les plus anciens sont
//! supprimés.

use std::path::Path;

const KEEP_REPORTS: usize = 30;
/// Lignes de détail technique gardées par échec (la fin de la sortie est la plus utile).
const MAX_DETAIL_LINES: usize = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// La version relue après l'installation est la bonne.
    Confirmed,
    /// Installé, mais la version ne peut pas être relue (jamais lisible, programme introuvable).
    Unverifiable,
    /// Installé ; la version ne sera à jour qu'après un redémarrage (« system » ou « app »).
    Restart(&'static str),
    /// Installé, mais l'ancienne version est toujours détectée.
    StillOutdated,
    /// Échec : message simple, code de sortie et détail technique.
    Failed {
        message: String,
        code: Option<i64>,
        detail: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub id: String,
    /// Version installée avant la mise à jour.
    pub before: Option<String>,
    /// Version que l'analyse annonçait.
    pub expected: Option<String>,
    /// Version relue après l'installation.
    pub after: Option<String>,
    pub outcome: Outcome,
}

/// « inconnue » quand la version n'est pas lisible.
fn show(version: &Option<String>) -> String {
    match version.as_deref().map(str::trim) {
        None | Some("") => "inconnue".into(),
        Some(v) if matches!(v.to_lowercase().as_str(), "unknown" | "inconnu") => "inconnue".into(),
        Some(v) => v.to_string(),
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n > 1 { many } else { one })
}

fn summary(entries: &[Entry]) -> String {
    let count = |f: fn(&Outcome) -> bool| entries.iter().filter(|e| f(&e.outcome)).count();
    let parts = [
        (
            count(|o| matches!(o, Outcome::Confirmed)),
            "mise à jour confirmée",
            "mises à jour confirmées",
        ),
        (
            count(|o| matches!(o, Outcome::Restart(_))),
            "en attente d'un redémarrage",
            "en attente d'un redémarrage",
        ),
        (
            count(|o| matches!(o, Outcome::Unverifiable)),
            "non vérifiable",
            "non vérifiables",
        ),
        (
            count(|o| matches!(o, Outcome::StillOutdated)),
            "à vérifier",
            "à vérifier",
        ),
        (
            count(|o| matches!(o, Outcome::Failed { .. })),
            "échec",
            "échecs",
        ),
    ];
    parts
        .iter()
        .filter(|(n, _, _)| *n > 0)
        .map(|(n, one, many)| plural(*n, one, many))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Texte du rapport. `title` distingue une session normale d'un nouvel essai avec autorisation ;
/// `when` est la date affichée ; `manager` est le chemin du gestionnaire (détail technique).
pub fn build(title: &str, when: &str, entries: &[Entry], manager: Option<&str>) -> String {
    let mut out = vec![format!("=== {title} — {when} ==="), String::new()];
    out.push(format!("Résumé : {}", summary(entries)));
    out.push(String::new());

    for e in entries {
        let head = match &e.outcome {
            Outcome::Confirmed => format!("✓ {} ({}) — Mise à jour confirmée", e.name, e.id),
            Outcome::Unverifiable => {
                format!(
                    "✓ {} ({}) — Mis à jour (version non vérifiable)",
                    e.name, e.id
                )
            }
            Outcome::Restart("system") => {
                format!(
                    "✓ {} ({}) — Mis à jour (redémarrage du PC requis)",
                    e.name, e.id
                )
            }
            Outcome::Restart(_) => {
                format!(
                    "✓ {} ({}) — Mis à jour (redémarrage du logiciel requis)",
                    e.name, e.id
                )
            }
            Outcome::StillOutdated => format!(
                "⚠ {} ({}) — Installé, mais l'ancienne version est toujours détectée",
                e.name, e.id
            ),
            Outcome::Failed { message, .. } => {
                format!("✗ {} ({}) — Échec : {message}", e.name, e.id)
            }
        };
        out.push(head);
        let mut versions = format!(
            "    Version avant : {} · attendue : {}",
            show(&e.before),
            show(&e.expected)
        );
        if !matches!(e.outcome, Outcome::Failed { .. }) {
            versions.push_str(&format!(" · relue après : {}", show(&e.after)));
        }
        out.push(versions);

        if let Outcome::Failed { code, detail, .. } = &e.outcome {
            let code = code.map_or(String::new(), |c| format!(" (code de sortie : {c})"));
            out.push(format!("    Détail technique{code} :"));
            if detail.is_empty() {
                out.push("      (aucune sortie capturée)".into());
            }
            let skipped = detail.len().saturating_sub(MAX_DETAIL_LINES);
            if skipped > 0 {
                out.push(format!("      … {skipped} lignes plus haut non reprises"));
            }
            out.extend(detail.iter().skip(skipped).map(|l| format!("      {l}")));
        }
        out.push(String::new());
    }

    if let Some(manager) = manager {
        out.push("--- Détails techniques ---".into());
        out.push(format!("Gestionnaire : {manager}"));
    }
    out.join("\n")
}

/// Écrit le rapport dans `dir` sous un nom unique, puis supprime les plus anciens.
pub fn write(dir: Option<&Path>, text: &str) -> Option<String> {
    let dir = dir?;
    std::fs::create_dir_all(dir).ok()?;
    let base = format!(
        "update-{}",
        chrono::Local::now().format("%Y-%m-%dT%H-%M-%S")
    );
    // Deux sessions dans la même seconde ne s'écrasent pas.
    let mut path = dir.join(format!("{base}.log"));
    for n in 2.. {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{base}-{n}.log"));
    }
    std::fs::write(&path, text).ok()?;
    log::info!("[mises à jour] rapport écrit : {}", path.display());
    prune(dir, KEEP_REPORTS);
    Some(path.to_string_lossy().into_owned())
}

/// Ne garde que les `keep` derniers rapports (les noms contiennent la date : l'ordre
/// alphabétique est l'ordre chronologique). Les autres fichiers du dossier ne sont pas touchés.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut reports: Vec<_> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("update-") && name.ends_with(".log")
        })
        .map(|e| e.path())
        .collect();
    reports.sort();
    let excess = reports.len().saturating_sub(keep);
    for old in reports.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, id: &str, outcome: Outcome) -> Entry {
        Entry {
            name: name.into(),
            id: id.into(),
            before: Some("1.0".into()),
            expected: Some("2.0".into()),
            after: Some("2.0".into()),
            outcome,
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cleaner_pc_report_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn report_lists_every_outcome_with_its_versions() {
        let entries = vec![
            entry("Git", "Git.Git", Outcome::Confirmed),
            Entry {
                after: Some("1.0".into()),
                ..entry("Figma", "Figma.Figma", Outcome::StillOutdated)
            },
            Entry {
                before: Some("Unknown".into()),
                after: None,
                ..entry("OpenAL", "Creative.OpenAL", Outcome::Unverifiable)
            },
            entry("Node.js", "OpenJS.NodeJS", Outcome::Restart("system")),
            Entry {
                after: None,
                ..entry(
                    "CCleaner",
                    "Piriform.CCleaner",
                    Outcome::Failed {
                        message: "L'éditeur a modifié son fichier d'installation".into(),
                        code: Some(2_316_632_081),
                        detail: vec![
                            "Trouvé CCleaner".into(),
                            "Le code de hachage ne correspond pas.".into(),
                        ],
                    },
                )
            },
        ];
        let text = build(
            "Rapport de mise à jour",
            "11/11/2026 14:12:03",
            &entries,
            Some("C:\\winget.exe"),
        );
        println!("{text}");

        assert!(text.starts_with("=== Rapport de mise à jour — 11/11/2026 14:12:03 ==="));
        assert!(text.contains(
            "Résumé : 1 mise à jour confirmée · 1 en attente d'un redémarrage · 1 non vérifiable · 1 à vérifier · 1 échec"
        ));
        assert!(text.contains("✓ Git (Git.Git) — Mise à jour confirmée"));
        assert!(text.contains("Version avant : 1.0 · attendue : 2.0 · relue après : 2.0"));
        assert!(text.contains(
            "⚠ Figma (Figma.Figma) — Installé, mais l'ancienne version est toujours détectée"
        ));
        assert!(
            text.contains("relue après : 1.0"),
            "la version relue du cas « à vérifier »"
        );
        assert!(
            text.contains("Version avant : inconnue · attendue : 2.0 · relue après : inconnue")
        );
        assert!(text.contains("✓ Node.js (OpenJS.NodeJS) — Mis à jour (redémarrage du PC requis)"));
        assert!(text.contains("✗ CCleaner (Piriform.CCleaner) — Échec : L'éditeur a modifié son fichier d'installation"));
        assert!(text.contains("Détail technique (code de sortie : 2316632081) :"));
        assert!(text.contains("      Le code de hachage ne correspond pas."));
        assert!(text.ends_with("Gestionnaire : C:\\winget.exe"));
    }

    #[test]
    fn a_failure_does_not_pretend_to_have_reread_a_version() {
        let e = Entry {
            after: None,
            ..entry(
                "X",
                "X.X",
                Outcome::Failed {
                    message: "m".into(),
                    code: None,
                    detail: vec![],
                },
            )
        };
        let text = build("Rapport", "date", &[e], None);
        assert!(text.contains("Version avant : 1.0 · attendue : 2.0\n"));
        assert!(!text.contains("relue après"));
        assert!(text.contains("(aucune sortie capturée)"));
        assert!(
            !text.contains("Détails techniques"),
            "pas de gestionnaire : pas de section"
        );
    }

    #[test]
    fn long_technical_output_keeps_only_the_end() {
        let detail: Vec<String> = (1..=100).map(|i| format!("ligne {i}")).collect();
        let e = entry(
            "X",
            "X.X",
            Outcome::Failed {
                message: "m".into(),
                code: Some(1),
                detail,
            },
        );
        let text = build("Rapport", "date", &[e], None);
        assert!(text.contains("… 70 lignes plus haut non reprises"));
        assert!(
            text.contains("ligne 100") && text.contains("ligne 71") && !text.contains("ligne 70\n")
        );
    }

    #[test]
    fn summary_uses_singular_and_plural() {
        let two = [
            entry("A", "A.A", Outcome::Confirmed),
            entry("B", "B.B", Outcome::Confirmed),
        ];
        assert_eq!(summary(&two), "2 mises à jour confirmées");
        assert_eq!(summary(&two[..1]), "1 mise à jour confirmée");
        assert_eq!(summary(&[]), "");
    }

    #[test]
    fn writing_gives_unique_names_and_keeps_the_latest_reports() {
        let dir = temp_dir("write");
        let first = write(Some(&dir), "un").unwrap();
        let second = write(Some(&dir), "deux").unwrap();
        assert_ne!(first, second, "même seconde : pas d'écrasement");
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "un");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "deux");
        assert!(write(None, "x").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_oldest_reports_are_pruned() {
        let dir = temp_dir("prune");
        std::fs::create_dir_all(&dir).unwrap();
        for day in 1..=35 {
            std::fs::write(
                dir.join(format!("update-2026-10-{day:02}T10-00-00.log")),
                "x",
            )
            .unwrap();
        }
        // Les autres fichiers du dossier ne sont jamais supprimés.
        std::fs::write(dir.join("main.log"), "journal").unwrap();
        std::fs::write(dir.join("notes.txt"), "notes").unwrap();

        prune(&dir, 30);

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let reports: Vec<_> = names.iter().filter(|n| n.starts_with("update-")).collect();
        assert_eq!(reports.len(), 30);
        assert!(
            !names.contains(&"update-2026-10-05T10-00-00.log".to_string()),
            "les 5 plus anciens"
        );
        assert!(names.contains(&"update-2026-10-06T10-00-00.log".to_string()));
        assert!(
            names.contains(&"update-2026-10-35T10-00-00.log".to_string())
                || names.contains(&"update-2026-10-31T10-00-00.log".to_string())
        );
        assert!(
            names.contains(&"main.log".to_string()) && names.contains(&"notes.txt".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
