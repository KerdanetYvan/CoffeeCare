// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSystemInfo: () => ipcRenderer.invoke('system:getInfo'),
  getTempDirs: () => ipcRenderer.invoke('scan:getTempDirs'),
});
