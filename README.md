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
3. Cleaner PC s'installe et se lance automatiquement

---

## Développement

### Prérequis développement

- [Node.js](https://nodejs.org/) 20+
- npm

### Lancer en mode développement

```bash
npm install
npm run dev
```

Vite + Electron démarrent en parallèle avec le rechargement à chaud (HMR).  
Les DevTools s'ouvrent automatiquement.

### Construire

```bash
npm run build   # Build de production
npm run make    # Génère l'installeur distributable
```

---

## Stack technique

| Couche | Technologie |
| ------- | ----------- |
| Desktop | Electron 38 |
| Frontend | React 19 + TypeScript 5.9 |
| Bundler | Vite 7 |
| Routing | React Router v7 (HashRouter) |
| Style | Tailwind CSS 3.4 |
| Icônes | Lucide React |
| Logs | electron-log |

---

## Changelog

Voir [CHANGELOG.md](./CHANGELOG.md) pour l'historique des versions.
