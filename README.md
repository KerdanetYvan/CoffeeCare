# Cleaner PC

Application de maintenance PC pour Windows, conçue pour le grand public.  
Nettoyage, réparation et mises à jour en quelques clics — sans jargon technique.

> **Statut : alpha** — en développement actif. Des bugs peuvent survenir.

---

## Fonctionnalités

| Module | Description |
| ------------ | -------------------------------------------- |
| Dashboard | Vue d'ensemble du système : OS, CPU, RAM, uptime |
| Nettoyage | Suppression des fichiers temporaires et caches |
| Réparation | Services Windows, fichiers système, registre, disque |
| Mises à jour | Logiciels (winget) et pilotes |
| Paramètres | Démarrage automatique, informations sur l'application |

---

## Prérequis

- Windows 10 ou Windows 11
- Droits administrateur (requis pour certaines opérations de réparation et nettoyage)

---

## Installation

1. Télécharger le fichier `.exe` depuis la section [Releases](../../releases)
2. Lancer l'installeur et suivre les étapes
3. Une fois l'installation terminée, lancez Cleaner PC depuis le menu Démarrer

---

## Développement

### Prérequis développement

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (version stable récente)
- Les « Outils de build Visual Studio » avec la charge de travail **Développement Desktop en C++** (`winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`)
- WebView2 (déjà présent sur Windows 11)

### Lancer en mode développement

```bash
npm install
npm run dev
```

Vite et Tauri démarrent ensemble avec le rechargement à chaud (HMR). La première compilation de la partie Rust prend quelques minutes.

### Construire

```bash
npm run build        # Génère l'installeur Windows (src-tauri/target/release/bundle/nsis)
npm run build:web    # Interface seule (Vite)
npm run lint         # ESLint
npm run typecheck    # TypeScript
cd src-tauri && cargo test    # Tests Rust
```

---

## Stack technique

| Couche | Technologie |
| ------- | ----------- |
| Desktop | Tauri 2 (Rust) |
| Frontend | React 19 + TypeScript 5.9 |
| Bundler | Vite 7 |
| Routing | React Router v7 (HashRouter) |
| Style | Tailwind CSS 3.4 |
| Icônes | Lucide React |
| Logs | tauri-plugin-log |

---

## Changelog

Voir [CHANGELOG.md](./CHANGELOG.md) pour l'historique des versions.
