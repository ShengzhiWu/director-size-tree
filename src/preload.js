const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskTree', {
  scan: () => ipcRenderer.invoke('scan:start'),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('scan:update', listener);
    return () => ipcRenderer.removeListener('scan:update', listener);
  }
});
