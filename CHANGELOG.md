# Changelog

Toutes les modifications notables de Cleaner PC sont documentées ici.

Format basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/),
versionnage selon [Semantic Versioning](https://semver.org/lang/fr/).

---

## [0.1.0-alpha.2] — 2026-07-01

Mise à jour de stabilité.

### Corrigé

- Empêche l'application de s'ouvrir plusieurs fois en même temps, ce qui pouvait bloquer certains fichiers lors d'une réinstallation ou d'une mise à jour

### Connu

- Le thème sombre n'est pas encore disponible
- L'interface est disponible uniquement en français

## [0.1.0-alpha.1] — 2026-07-01

Première version alpha publique.

### Ajouté

- **Dashboard** — vue d'ensemble du système : OS, processeur, RAM (usage en temps réel), durée de fonctionnement
- **Nettoyage** — détection et suppression des fichiers temporaires (dossiers système, caches navigateurs, corbeille)
- **Réparation**
  - Vérification et relance des programmes essentiels Windows (services critiques)
  - Vérification des fichiers système (SFC)
  - Diagnostic des composants et périphériques
  - Détection et suppression des programmes fantômes (entrées de registre orphelines)
  - Gestion des programmes au démarrage
  - État de santé du disque dur (SMART)
- **Mises à jour** — détection et installation des mises à jour logicielles (winget) et des pilotes
- **Paramètres** — lancement automatique au démarrage de Windows, section à propos avec numéro de version

### Connu

- Le thème sombre n'est pas encore disponible
- L'interface est disponible uniquement en français
