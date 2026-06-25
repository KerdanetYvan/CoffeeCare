# CoffeeCare — Guide de développement

## Vue d'ensemble

CoffeeCare est une application desktop Windows de maintenance PC (nettoyage, réparation, mises à jour), construite avec Electron + React + TypeScript. L'interface est entièrement en **français**.

Un webdesigner travaille sur les maquettes — le style actuel est intentionnellement minimaliste et sera remplacé. Ne pas sur-investir dans le CSS avant réception des maquettes finales.

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Desktop | Electron 38 |
| Frontend | React 19 + TypeScript 5.9 |
| Bundler | Vite 7 |
| Routing | React Router v7 (HashRouter) |
| Style | Tailwind CSS 3.4 |
| Icônes | Lucide React |
| Logs | electron-log |

## Lancer le projet

```bash
npm run dev    # Vite + Electron en parallèle (HMR actif)
npm run build  # Build Vite de production
npm start      # Lancer Electron sur le build
```

## Architecture

### Communication Electron ↔ React (IPC)

Le pattern IPC suit toujours trois fichiers :

```
electron/main.js          ipcMain.handle('channel:action', handler)
electron/preload.js       contextBridge.exposeInMainWorld('api', { method })
src/pages/*.tsx           window.api.method()
```

Les noms de canaux suivent la convention `domaine:action` (ex. `system:getInfo`, `scan:getTempDirs`).

La sécurité Electron est non-négociable : `contextIsolation: true` et `sandbox: true` restent activés. Ne jamais exposer `ipcRenderer` directement dans le preload.

### Structure des fichiers

```
electron/
  main.js          # Process principal : fenêtre, IPC handlers
  preload.js       # Context bridge uniquement — aucune logique métier

src/
  App.tsx          # Router + lazy loading des pages
  components/
    layout/
      MainLayout.tsx   # Layout partagé (header + sidebar + <Outlet>)
  pages/
    Dashboard.tsx      # Implémenté
    Cleaning.tsx       # Stub
    Repair.tsx         # Stub
    Updates.tsx        # Stub
    Settings.tsx       # Stub
    NotFound.tsx       # 404
```

### Routing

HashRouter est utilisé (obligatoire avec Electron en `file://`). Ne pas migrer vers BrowserRouter.

Routes actuelles :
- `/` → Dashboard
- `/cleaning` → Nettoyage
- `/repair` → Réparation
- `/updates` → Mises à jour
- `/settings` → Paramètres

Toutes les pages sont chargées en **lazy** via `React.lazy()` + `<Suspense>`.

### Layout

`MainLayout` crée une grille CSS fixe :
- Header 56px (col-span-2)
- Sidebar 240px fixe à gauche
- Zone contenu (`<Outlet>`) à droite, scrollable

## Langage et ton de l'interface

**La cible principale est le grand public non-développeur** : personnes peu à l'aise avec l'informatique, qui veulent juste que leur PC "aille mieux". Il faut :

- **Bannir le jargon technique** dans les labels, boutons, messages et descriptions. Exemples :
  - ❌ "Lancer SFC /scannow" → ✅ "Vérifier les fichiers système"
  - ❌ "Services Windows arrêtés ou désactivés" → ✅ "Programmes essentiels de Windows"
  - ❌ "UAC" → ✅ "Windows va vous demander l'autorisation"
  - ❌ "Erreur 0x80..." → ✅ "Une erreur est survenue, réessayez"
- **Vulgariser pour rassurer** : expliquer brièvement ce que fait une action, sans entrer dans les détails techniques. L'utilisateur doit comprendre *pourquoi* il clique, pas *comment* ça fonctionne.
- **Ton calme et positif** : éviter les formulations alarmistes. Préférer "Votre système semble en bonne santé" à "Aucune violation d'intégrité détectée".
- **Les abréviations et noms internes** (SFC, DISM, winget, CBS.log, IPC…) ne doivent jamais apparaître dans l'UI visible par l'utilisateur.

Cette règle s'applique à tous les textes UI : titres, descriptions, boutons, messages d'état, bandeaux d'erreur, warnings.

## Conventions de code

### TypeScript

- Mode strict activé (`noUnusedLocals`, `noUnusedParameters`).
- Déclarer les types des réponses IPC dans le fichier de page qui les consomme (voir `declare global { interface Window { api: ... } }` dans Dashboard.tsx).
- Préférer `interface` pour les shapes de données, `type` pour les unions et alias.

### Composants React

- Un fichier = un composant exporté par défaut.
- Les hooks custom vont dans `src/hooks/` (dossier à créer au besoin).
- Pas de state management global pour l'instant — React local state suffit. N'introduire Zustand ou Context qu'à partir du moment où deux pages distantes partagent le même état.

### Styles Tailwind

- Couleur principale de la marque : `bole` = `rgb(76, 41, 34)` (brun café).
- Pattern de carte standard : `bg-white dark:bg-neutral-800 p-6 rounded-lg shadow-md border border-neutral-200 dark:border-neutral-700`.
- Ne pas créer de classes CSS custom pour ce que Tailwind gère déjà.
- Attendre les maquettes avant de figer un design system.

### Electron / main.js

- Le fichier est en CommonJS (`require`/`module.exports`) — ne pas mélanger avec l'ESM du frontend.
- Chaque nouvelle fonctionnalité système = un nouveau `ipcMain.handle` dans `main.js` + son exposition dans `preload.js`.
- Les handlers IPC renvoient toujours `{ ok: boolean, data: ... }` pour les opérations qui peuvent échouer, ou directement l'objet pour les lectures simples (voir `system:getInfo`).

### Nommage

- Fichiers composants : PascalCase (`MainLayout.tsx`, `Dashboard.tsx`)
- Fichiers Electron : camelCase (`main.js`, `preload.js`)
- Canaux IPC : `domaine:action` en camelCase (`scan:getTempDirs`)

## État d'avancement des fonctionnalités

| Page | État | Notes |
|------|------|-------|
| Dashboard | Fonctionnel | Infos OS, CPU, RAM, uptime. RAM usage hardcodé à 65% (à brancher) |
| Cleaning | Stub | Détection des dossiers temp déjà en IPC (`scan:getTempDirs`) |
| Repair | Stub | — |
| Updates | Stub | Doit utiliser winget |
| Settings | Stub | Thème, langue, télémétrie (prévu) |

## Points d'attention

- **RAM usage** dans Dashboard : la barre est hardcodée à 65%. Brancher `os.freemem()` via IPC.
- **Logs de debug** dans `main.js` : trois logs de test (info/warn/error) sont à supprimer avant release.
- **Packaging** : aucun outil de packaging (electron-builder / electron-forge) n'est encore configuré.
- **`dist/index.html`** en prod : le chemin est relatif à `process.cwd()` dans `main.js` — à valider lors de la mise en place du packaging.
