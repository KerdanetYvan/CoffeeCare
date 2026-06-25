# CoffeeCare

Application desktop Windows de maintenance PC — nettoyage, réparation et mises à jour système.

Construite avec **Electron + React + TypeScript + Vite + Tailwind CSS**.

## Fonctionnalités prévues

| Module | Description |
| ------ | ----------- |
| Dashboard | Vue d'ensemble : OS, CPU, RAM, uptime |
| Nettoyage | Suppression de fichiers temporaires et caches |
| Réparation | Diagnostic et correctifs (services, registres, pilotes) |
| Mises à jour | Pilotes, Windows Update, applications via winget |
| Paramètres | Thème, langue, télémétrie, chemins personnalisés |

## Prérequis

- Node.js 20+
- npm 10+
- Windows 10/11

## Installation

```bash
npm install
```

## Développement

```bash
npm run dev
```

Lance Vite (HMR) et Electron en parallèle. Les DevTools s'ouvrent automatiquement en mode dev.

## Build

```bash
npm run build   # Génère dist/
npm start       # Lance Electron sur le build
```

## Stack

- **Electron 38** — runtime desktop
- **React 19** — UI
- **TypeScript 5.9** — typage strict
- **Vite 7** — bundler avec HMR
- **React Router v7** — navigation (HashRouter pour compatibilité Electron)
- **Tailwind CSS 3.4** — styles utilitaires
- **Lucide React** — icônes
- **electron-log** — logs applicatifs
