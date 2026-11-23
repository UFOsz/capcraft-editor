const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('capcraft', {
  openVideo: () => ipcRenderer.invoke('open-video'),
  openMedia: () => ipcRenderer.invoke('open-media'),
  saveVideo: (suggested) => ipcRenderer.invoke('save-video', suggested),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  toggleDevtools: () => ipcRenderer.invoke('toggle-devtools'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  appInfo: () => ipcRenderer.invoke('app-info'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdate: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data))
})
