import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Pendant la migration d'Electron vers Tauri, les pages continuent d'appeler
 * `window.api.*`. Sous Electron, c'est le preload qui le fournit ; sous Tauri,
 * ce fichier le construit au-dessus de `invoke()`.
 *
 * Les fonctions pas encore portées en Rust échouent avec un message clair.
 * À supprimer quand les pages appelleront directement `invoke()`.
 */

type Api = Window['api'];

function notPorted(name: string) {
  return () => Promise.reject(new Error(`Fonction pas encore disponible : ${name}`));
}

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
    getSoftwareUpdates: notPorted('getSoftwareUpdates'),
    getDriverUpdates: notPorted('getDriverUpdates'),
    installSoftwareStream: notPorted('installSoftwareStream'),
    onSwProgress: () => {},
    offSwProgress: () => {},
    openLogFile: (path) => invoke('shell_open_log', { path }),
    installElevated: notPorted('installElevated'),
    closeRelatedApp: notPorted('closeRelatedApp'),
    installDrivers: notPorted('installDrivers'),

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
