const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskTree', {
  openFolder: (folderPath) => ipcRenderer.invoke('folder:open', folderPath),
  scan: () => ipcRenderer.invoke('scan:start'),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('scan:update', listener);
    return () => ipcRenderer.removeListener('scan:update', listener);
  }
});
