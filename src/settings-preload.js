'use strict';

// The settings window's whole reach into main: what to show, a change to save (main checks every
// key and type), a new API key (sent, never read back), a reset, a restart, her menu and closing;
// and the updates of the app (updates.js): check, download, install (once confirmed in the window), the
// release page (main opens only this repository's).
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
  // a section asked from outside (her menu's "Update available"), while the window is open
  onSection: (fn) => {
    const listener = (_e, id) => fn(id);
    ipcRenderer.on('settings:section', listener);
    return () => ipcRenderer.removeListener('settings:section', listener);
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: (confirmed) => ipcRenderer.invoke('updates:install', confirmed === true),
    page: () => ipcRenderer.send('updates:page'),
    onStatus: (fn) => {
      const listener = (_e, status) => fn(status);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },
});
