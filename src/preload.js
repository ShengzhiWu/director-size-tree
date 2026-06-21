const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskTree', {
  loadResults: () => ipcRenderer.invoke('results:load'),
  openFolder: (folderPath) => ipcRenderer.invoke('folder:open', folderPath),
  saveResults: (tree) => ipcRenderer.invoke('results:save', tree),
  scan: () => ipcRenderer.invoke('scan:start'),
  onLoadRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('results:load-request', listener);
    return () => ipcRenderer.removeListener('results:load-request', listener);
  },
  onSaveRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('results:save-request', listener);
    return () => ipcRenderer.removeListener('results:save-request', listener);
  },
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('scan:update', listener);
    return () => ipcRenderer.removeListener('scan:update', listener);
  }
});
