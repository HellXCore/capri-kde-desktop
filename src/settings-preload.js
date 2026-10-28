'use strict';

// The settings window's whole reach into main: what to show, and three things it can ask.
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
  openMenu: () => ipcRenderer.send('settings:menu'),
  close: () => ipcRenderer.send('settings:close'),
});
