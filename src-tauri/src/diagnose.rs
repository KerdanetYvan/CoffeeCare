//! Explique en français simple pourquoi la mise à jour d'un logiciel a échoué.
//!
//! Le gestionnaire de paquets renvoie un code et un texte (français ou anglais selon
//! l'installateur). On en tire deux choses : un **message** pour l'utilisateur, sans jargon,
//! et un **type** d'échec qui dit à l'interface quel bouton proposer, sans avoir à relire le
//! message. Les codes viennent de la documentation officielle de winget (returnCodes.md).

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

pub const GENERIC_ERROR: &str = "Une erreur est survenue, réessayez";

/// Ce que l'utilisateur peut faire, et donc le bouton que l'interface propose.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// L'installation demande l'autorisation de Windows : proposer « Réessayer avec autorisation ».
    NeedsPermission,
    /// Le programme est ouvert ou utilisé : proposer « Fermer l'application ».
    CloseApp,
    /// Souvent passager (réseau, installation déjà en cours, fichier de l'éditeur modifié).
    RetryLater,
    /// L'app n'y peut rien : l'utilisateur doit passer par le site de l'éditeur.
    UpdateManually,
    /// Autre : le détail est dans le rapport.
    Other,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Diagnosis {
    pub kind: FailureKind,
    pub message: String,
}

use FailureKind::{CloseApp, NeedsPermission, Other, RetryLater, UpdateManually};

/// Textes (français ou anglais) qui désignent une cause précise. Ils passent avant les codes :
/// plus précis, et certains échecs partagent le même code.
static TEXT_RULES: LazyLock<Vec<(Regex, FailureKind, &'static str)>> = LazyLock::new(|| {
    [
        // Autorisation de Windows
        (
            r"(?i)administrator privileges|requires? administrator|(?:droits?|privilèges?) d.administrateur|s.exécuter en tant qu.administrateur|code de sortie.*3221226525",
            NeedsPermission,
            "Cette mise à jour a besoin de votre autorisation",
        ),
        // Programme ouvert
        (
            r"(?i)fichiers.{0,80}actuellement utilis|application is currently running|exit the application|files? .{0,40}in use",
            CloseApp,
            "Fermez l'application, puis réessayez",
        ),
        (
            r"(?i)code de sortie[^\n]*\b6\b",
            CloseApp,
            "Fermez l'application, puis réessayez",
        ),
        // Fichier de l'éditeur
        (
            r"(?i)code de hachage.{0,40}ne correspond pas|hash.{0,40}(?:does not match|mismatch)",
            RetryLater,
            "L'éditeur a modifié son fichier d'installation. Réessayez dans quelques jours",
        ),
        (
            r"(?i)\(403\)|forbidden",
            UpdateManually,
            "L'éditeur refuse le téléchargement automatique. Mettez à jour depuis son site",
        ),
        (
            r"(?i)\(404\)",
            UpdateManually,
            "Le fichier d'installation est introuvable chez l'éditeur. Mettez à jour depuis son site",
        ),
        // Ancienne version
        (
            r"(?i)ne trouve pas la commande de désinstallation|uninstall command not found",
            UpdateManually,
            "L'ancienne version ne peut pas être retirée automatiquement. Mettez à jour depuis le site de l'éditeur",
        ),
        (
            r"(?i)technologie d.installation différente",
            UpdateManually,
            "Ce programme doit être réinstallé manuellement",
        ),
        // Compatibilité
        (
            r"(?i)aucune mise à (?:niveau|upgrade) applicable|ne s.applique pas à votre système",
            Other,
            "Pas de version compatible pour votre système",
        ),
        (
            r"(?i)aucun package installé ne correspond|no installed package found|application not found",
            Other,
            "Programme non reconnu",
        ),
        (
            r"(?i)impossible de déterminer le numéro de version",
            Other,
            "La version de ce programme ne peut pas être identifiée",
        ),
        // Réseau et durée
        (
            r"(?i)délai dépassé",
            RetryLater,
            "L'installation a pris trop de temps et a été arrêtée. Réessayez, ou installez depuis le site de l'éditeur",
        ),
        (
            r"(?i)une erreur inattendue s.est produite",
            RetryLater,
            GENERIC_ERROR,
        ),
    ]
    .into_iter()
    .map(|(pattern, kind, message)| (Regex::new(pattern).unwrap(), kind, message))
    .collect()
});

/// Codes de sortie connus (0x8A15… : codes de winget ; 0x8007… et 0x8019… : codes Windows).
const CODE_RULES: &[(u32, FailureKind, &str)] = &[
    // Autorisation
    (
        0x8007_3D28,
        NeedsPermission,
        "Cette mise à jour a besoin de votre autorisation",
    ),
    (
        0x8A15_0019,
        NeedsPermission,
        "Cette mise à jour a besoin de votre autorisation",
    ),
    (
        3_221_226_525,
        NeedsPermission,
        "Cette mise à jour a besoin de votre autorisation",
    ),
    // Programme ouvert ou ancien programme impossible à retirer
    (
        0x8A15_0101,
        CloseApp,
        "Fermez l'application, puis réessayez",
    ),
    (
        0x8A15_0103,
        CloseApp,
        "Fermez l'application, puis réessayez",
    ),
    (
        0x8A15_0111,
        CloseApp,
        "Fermez l'application, puis réessayez",
    ),
    (
        0x8A15_0030,
        CloseApp,
        "L'ancienne version n'a pas pu être retirée. Fermez le programme, puis réessayez",
    ),
    // Passager
    (
        0x8A15_0011,
        RetryLater,
        "L'éditeur a modifié son fichier d'installation. Réessayez dans quelques jours",
    ),
    (
        0x8A15_0008,
        RetryLater,
        "Le téléchargement a échoué. Vérifiez votre connexion internet, puis réessayez",
    ),
    (
        0x8A15_0107,
        RetryLater,
        "Ce programme a besoin d'internet. Vérifiez votre connexion, puis réessayez",
    ),
    (
        0x8A15_0102,
        RetryLater,
        "Une autre installation est en cours. Attendez qu'elle se termine, puis réessayez",
    ),
    (
        0x8A15_010A,
        RetryLater,
        "Redémarrez votre PC, puis réessayez",
    ),
    // Site de l'éditeur
    (
        0x8A15_002F,
        UpdateManually,
        "L'ancienne version ne peut pas être retirée automatiquement. Mettez à jour depuis le site de l'éditeur",
    ),
    (
        0x8019_0193,
        UpdateManually,
        "L'éditeur refuse le téléchargement automatique. Mettez à jour depuis son site",
    ),
    (
        0x8019_0194,
        UpdateManually,
        "Le fichier d'installation est introuvable chez l'éditeur. Mettez à jour depuis son site",
    ),
    // Le reste
    (
        0x8A15_0006,
        Other,
        "Le programme d'installation a rencontré un problème. Réessayez, ou mettez à jour depuis le site de l'éditeur",
    ),
    (
        0x8A15_0010,
        Other,
        "Pas de version compatible pour votre système",
    ),
    (0x8A15_0014, Other, "Programme non reconnu"),
    (
        0x8A15_0104,
        Other,
        "Ce programme a besoin d'un autre composant qui n'est pas installé",
    ),
    (
        0x8A15_0110,
        Other,
        "Un composant nécessaire à ce programme n'a pas pu être installé",
    ),
    (
        0x8A15_0105,
        Other,
        "Il n'y a plus assez de place sur le disque. Libérez de l'espace, puis réessayez",
    ),
    (
        0x8A15_0106,
        Other,
        "Il n'y a pas assez de mémoire. Fermez d'autres applications, puis réessayez",
    ),
    (0x8A15_010C, Other, "L'installation a été annulée"),
    (
        0x8A15_010F,
        Other,
        "Une règle de votre organisation empêche cette installation",
    ),
    (
        0x8A15_0113,
        Other,
        "Ce programme n'est pas pris en charge par votre système",
    ),
];

/// Analyse un échec d'installation. `code` est le code de sortie non signé (ou -1 si le
/// programme n'a pas pu se terminer normalement).
pub fn diagnose(output: &str, code: i64) -> Diagnosis {
    for (pattern, kind, message) in TEXT_RULES.iter() {
        if pattern.is_match(output) {
            return Diagnosis {
                kind: *kind,
                message: (*message).into(),
            };
        }
    }
    if let Ok(code) = u32::try_from(code)
        && let Some((_, kind, message)) = CODE_RULES.iter().find(|(c, _, _)| *c == code)
    {
        return Diagnosis {
            kind: *kind,
            message: (*message).into(),
        };
    }
    Diagnosis {
        kind: Other,
        message: GENERIC_ERROR.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(output: &str, code: i64) -> FailureKind {
        diagnose(output, code).kind
    }

    // Les cas ci-dessous viennent du rapport d'échec réel du 13/07/2026 et d'un essai du 11/11/2026.

    #[test]
    fn missing_permission_is_recognised_in_french_and_english() {
        // Claude et WSL : message anglais de Windows, code 0x80073D28.
        let claude = "Démarrage du package d'installation... Merci de patienter.\n\
            Échec du programme d'installation avec le code de sortie : 0x80073d28 : The package installation failed because administrator privileges are required. Please contact an administrator to install this package.";
        assert_eq!(kind(claude, 2_147_958_056), NeedsPermission);
        assert_eq!(
            kind("", 2_147_958_056),
            NeedsPermission,
            "le code seul suffit"
        );

        // Git : le gestionnaire annonce une invite d'autorisation, puis l'installateur échoue.
        let git = "Le programme d’installation demande à s’exécuter en tant qu’administrateur. Attendez-vous à une invite.\n\
            Échec du programme d’installation avec le code de sortie : 1";
        assert_eq!(kind(git, 1), NeedsPermission);

        assert_eq!(kind("", 0x8A15_0019), NeedsPermission);
        assert_eq!(
            kind("Code de sortie de l'installeur : 3221226525", 1),
            NeedsPermission
        );
    }

    #[test]
    fn running_programs_ask_to_be_closed() {
        let in_use = "Les fichiers sont actuellement utilisés par un autre processus";
        assert_eq!(kind(in_use, 1), CloseApp);
        assert_eq!(kind("", 0x8A15_0111), CloseApp);
        assert_eq!(kind("", 0x8A15_0101), CloseApp);
        // Java 8 : l'ancienne version n'a pas pu être retirée.
        assert_eq!(kind("", 2_316_632_112), CloseApp);
        assert_eq!(
            kind(
                "Échec du programme d'installation avec le code de sortie : 6",
                1
            ),
            CloseApp
        );
    }

    #[test]
    fn an_installer_exit_code_that_merely_contains_a_six_is_not_a_closed_app() {
        // BleachBit : l'installateur a planté avec le code 666661.
        let bleachbit = "Ce package nécessite les dépendances suivantes :\n  Microsoft.VCRedist.2010.x86\n\
            Le code de hachage de l’installation a été vérifié avec succès\n\
            Échec du programme d’installation avec le code de sortie : 666661";
        let d = diagnose(bleachbit, 2_316_632_070);
        assert_eq!(d.kind, Other);
        assert!(
            d.message.contains("programme d'installation"),
            "{}",
            d.message
        );
    }

    #[test]
    fn publisher_side_problems_are_explained() {
        // CCleaner et PokeMMO : l'éditeur a changé son fichier sans prévenir.
        let ccleaner = "Le code de hachage du programme d’installation ne correspond pas.";
        let d = diagnose(ccleaner, 2_316_632_081);
        assert_eq!(d.kind, RetryLater);
        assert!(d.message.contains("modifié"));
        assert_eq!(kind("", 2_316_632_081), RetryLater, "PokeMMO : code seul");

        // Intel : le serveur refuse le téléchargement.
        let intel = "Une erreur inattendue s'est produite lors de l'exécution de la commande :\n\
            Download request status is not success.\n0x80190193 : Forbidden (403).";
        let d = diagnose(intel, 2_149_122_451);
        assert_eq!(
            d.kind, UpdateManually,
            "le 403 doit passer avant « erreur inattendue »"
        );
        assert!(d.message.contains("site"));

        // GanttProject : impossible de retirer l'ancienne version.
        let gantt = "WinGet ne trouve pas la commande de désinstallation de ce package. Contactez l’éditeur du package pour obtenir de l’aide.";
        assert_eq!(kind(gantt, 2_316_632_111), UpdateManually);
        assert_eq!(kind("", 2_316_632_111), UpdateManually);
    }

    #[test]
    fn long_installations_that_were_cut_off_can_be_retried() {
        // Docker, Epic Games, MongoDB : arrêtés à la fin du délai, aucune sortie.
        assert_eq!(kind("délai dépassé", -1), RetryLater);
    }

    #[test]
    fn unknown_failures_get_a_calm_generic_message_not_raw_output() {
        let d = diagnose(
            "Quelque chose d'inattendu\nDernière ligne technique : 0xDEADBEEF",
            42,
        );
        assert_eq!(
            d,
            Diagnosis {
                kind: Other,
                message: GENERIC_ERROR.into()
            }
        );
        assert_eq!(kind("", -1), Other);
    }

    #[test]
    fn every_message_is_free_of_jargon() {
        let messages = TEXT_RULES
            .iter()
            .map(|(_, _, m)| *m)
            .chain(CODE_RULES.iter().map(|(_, _, m)| *m));
        for message in messages {
            let lower = message.to_lowercase();
            for banned in [
                "winget",
                "0x",
                "code de sortie",
                "installeur",
                "hachage",
                "hash",
                "uninstall",
            ] {
                assert!(!lower.contains(banned), "« {banned} » dans : {message}");
            }
        }
    }

    #[test]
    fn code_table_has_no_duplicates() {
        for (i, (code, _, _)) in CODE_RULES.iter().enumerate() {
            assert!(
                !CODE_RULES[i + 1..].iter().any(|(c, _, _)| c == code),
                "code en double : {code:#X}"
            );
        }
    }
}
