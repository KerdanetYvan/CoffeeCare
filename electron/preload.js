// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Dashboard
  getSystemInfo:      ()        => ipcRenderer.invoke('system:getInfo'),

  // Nettoyage
  getTempDirs:        ()        => ipcRenderer.invoke('scan:getTempDirs'),
  deleteDirs:         (paths)   => ipcRenderer.invoke('clean:deleteDirs', paths),

  // Mises à jour
  getSoftwareUpdates:     ()    => ipcRenderer.invoke('updates:getSoftware'),
  getDriverUpdates:       ()    => ipcRenderer.invoke('updates:getDrivers'),
  installSoftwareStream:  (pkgs) => ipcRenderer.invoke('updates:installSoftwareStream', pkgs),
  onSwProgress:  (cb)           => ipcRenderer.on('updates:swProgress', (_, data) => cb(data)),
  offSwProgress: ()             => ipcRenderer.removeAllListeners('updates:swProgress'),
  openLogFile:      (p)           => ipcRenderer.invoke('shell:openPath', p),
  installElevated:  (pkg)         => ipcRenderer.invoke('updates:installElevated', pkg),
  closeRelatedApp:  (pkg)         => ipcRenderer.invoke('updates:closeRelatedApp', pkg),
  installDrivers:         ()    => ipcRenderer.invoke('updates:installDrivers'),

  // Réparation
  getServices:        ()        => ipcRenderer.invoke('repair:getServices'),
  fixServices:        (names)   => ipcRenderer.invoke('repair:fixServices', names),
  runSFC:             ()        => ipcRenderer.invoke('repair:runSFC'),
  getDriverErrors:    ()        => ipcRenderer.invoke('repair:getDriverErrors'),
  fixDriverErrors:    (ids)     => ipcRenderer.invoke('repair:fixDriverErrors', ids),
  getRegistryIssues:  ()        => ipcRenderer.invoke('repair:getRegistryIssues'),
  fixRegistryIssues:  (paths)   => ipcRenderer.invoke('repair:fixRegistryIssues', paths),
  getStartupItems:    ()        => ipcRenderer.invoke('repair:getStartupItems'),
  setStartupItems:    (changes) => ipcRenderer.invoke('repair:setStartupItems', changes),
  getDiskHealth:      ()        => ipcRenderer.invoke('repair:getDiskHealth'),
  scheduleDiskCheck:  (letters) => ipcRenderer.invoke('repair:scheduleDiskCheck', letters),

  // Paramètres
  getSettingsInfo:  ()             => ipcRenderer.invoke('settings:getInfo'),
  setLoginItem:     (v)            => ipcRenderer.invoke('settings:setLoginItem', v),

  // Fenêtre
  minimizeWindow:  () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow:  () => ipcRenderer.invoke('window:maximize'),
  closeWindow:     () => ipcRenderer.invoke('window:close'),
  isMaximized:     () => ipcRenderer.invoke('window:isMaximized'),
});
