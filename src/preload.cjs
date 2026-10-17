'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('monitor', {
  call: (action, value) => ipcRenderer.invoke('monitor:command', action, value),
  subscribe: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('monitor:state', listener); return () => ipcRenderer.removeListener('monitor:state', listener); },
  onNavigate: callback => ipcRenderer.on('monitor:navigate', (_event, value) => callback(value)),
  onDismiss: callback => ipcRenderer.on('monitor:dismiss-request', () => callback()),
});
