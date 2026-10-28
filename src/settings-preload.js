'use strict';

// The settings window's whole reach into main: what to show, a change to save (main checks every
// key and type), a new API key (sent, never read back), a reset, a restart, her menu and closing.
// Separate from the overlay's preload: this window gets none of the overlay's channels, and main
// answers these only from the settings window (settings-window.js `owns`).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsHost', {
  view: () => ipcRenderer.invoke('settings:view'),
  onView: (fn) => {
    const listener = (_e, view) => fn(view);
    ipcRenderer.on('settings:view', listener);
    return () => ipcRenderer.removeListener('settings:view', listener);
  },
  ready: (info) => ipcRenderer.send('settings:ready', info),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  saveKey: (provider, key) => ipcRenderer.invoke('settings:key', { provider, key }),
  reset: () => ipcRenderer.invoke('settings:reset'),
  restart: () => ipcRenderer.send('settings:restart'),
  openMenu: () => ipcRenderer.send('settings:menu'),
  close: () => ipcRenderer.send('settings:close'),
});
