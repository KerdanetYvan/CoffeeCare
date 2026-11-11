import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Pendant la migration d'Electron vers Tauri, les pages continuent d'appeler
 * `window.api.*`. Sous Electron, c'est le preload qui le fournit ; sous Tauri,
 * ce fichier le construit au-dessus de `invoke()`.
 *
 * À supprimer quand les pages appelleront directement `invoke()`.
 */

type Api = Window['api'];

/** Écouteurs de progression : leur inscription est asynchrone, on l'attend avant d'installer. */
let progressListeners: Promise<UnlistenFn>[] = [];

export function installTauriApi(): void {
  if (window.api || !isTauri()) return;

  const win = getCurrentWindow();

  const api: Api = {
    // Tableau de bord
    getSystemInfo: () => invoke('system_get_info'),

    // Nettoyage
    getTempDirs: () => invoke('scan_get_temp_dirs'),
    deleteDirs: (paths) => invoke('clean_delete_dirs', { paths }),

    // Mises à jour
    getSoftwareUpdates: () => invoke('updates_get_software'),
    getDriverUpdates: () => invoke('updates_get_drivers'),
    installSoftwareStream: async (packages) => {
      await Promise.all(progressListeners);
      return invoke('updates_install_software_stream', { packages });
    },
    onSwProgress: (cb) => {
      progressListeners.push(listen<Parameters<typeof cb>[0]>('updates:swProgress', (e) => cb(e.payload)));
    },
    offSwProgress: () => {
      const listeners = progressListeners;
      progressListeners = [];
      listeners.forEach((l) => void l.then((unlisten) => unlisten()));
    },
    openLogFile: (path) => invoke('shell_open_log', { path }),
    installElevated: (pkg) => invoke('updates_install_elevated', { pkg }),
    closeRelatedApp: (pkg) => invoke('updates_close_related_app', { pkg: { name: pkg.name } }),
    installDrivers: () => invoke('updates_install_drivers'),

    // Réparation
    getServices: () => invoke('repair_get_services'),
    fixServices: (names) => invoke('repair_fix_services', { names }),
    runSFC: () => invoke('repair_run_sfc'),
    getDriverErrors: () => invoke('repair_get_driver_errors'),
    fixDriverErrors: (ids) => invoke('repair_fix_driver_errors', { ids }),
    getRegistryIssues: () => invoke('repair_get_registry_issues'),
    fixRegistryIssues: (paths) => invoke('repair_fix_registry_issues', { paths }),
    getStartupItems: () => invoke('repair_get_startup_items'),
    setStartupItems: (changes) => invoke('repair_set_startup_items', { changes }),
    getDiskHealth: () => invoke('repair_get_disk_health'),
    scheduleDiskCheck: (letters) => invoke('repair_schedule_disk_check', { letters }),

    // Paramètres
    getSettingsInfo: () => invoke('settings_get_info'),
    setLoginItem: (openAtLogin) => invoke('settings_set_login_item', { openAtLogin }),

    // Fenêtre
    minimizeWindow: () => win.minimize(),
    maximizeWindow: () => win.toggleMaximize(),
    closeWindow: () => win.close(),
    isMaximized: () => win.isMaximized(),
  };

  window.api = api;
}
