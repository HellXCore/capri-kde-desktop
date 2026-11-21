'use strict';

// Load main.js far enough to catch composition-root wiring errors without Electron or a desktop.
// The app is stopped at whenReady(), before windows, tray, bridge or watchers are created.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'src/main/main.js');

function loadMainForTest() {
  const module = { exports: {} };
  const fileRequire = createRequire(MAIN);
  const appEvents = new EventEmitter();
  const screenEvents = new EventEmitter();
  const powerEvents = new EventEmitter();
  const ipcEvents = new EventEmitter();

  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  };

  const app = {
    isPackaged: false,
    commandLine: {
      getSwitchValue: () => '',
      appendSwitch() {},
    },
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), // stop before runtime side effects
    on: (...args) => appEvents.on(...args),
    once: (...args) => appEvents.once(...args),
    quit() {},
    exit() {},
    relaunch() {},
    getVersion: () => '0.0.0-test',
    getAppPath: () => ROOT,
    getPath: (name) => path.join(ROOT, '.tmp-main-load', name),
    setPath() {},
    getPreferredSystemLanguages: () => ['en-US'],
    getSystemLocale: () => 'en-US',
    getLocale: () => 'en-US',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    disableHardwareAcceleration() {},
    getGPUFeatureStatus: () => ({}),
    getApplicationNameForProtocol: () => '',
  };

  const electron = {
    app,
    BrowserWindow: class BrowserWindow {},
    Tray: class Tray {},
    Menu: {
      buildFromTemplate: (items) => ({ items }),
      setApplicationMenu() {},
    },
    ipcMain: {
      on: (...args) => ipcEvents.on(...args),
      handle: (...args) => ipcEvents.on(...args),
    },
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: (...args) => screenEvents.on(...args),
    },
    protocol: {
      registerSchemesAsPrivileged() {},
      handle() {},
    },
    net: {
      fetch: async () => new Response(''),
    },
    shell: {
      openExternal: async () => {},
      openPath: async () => '',
      showItemInFolder() {},
    },
    globalShortcut: {
      register: () => true,
      unregister() {},
      isRegistered: () => false,
      unregisterAll() {},
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true }),
    },
    clipboard: {
      write() {},
    },
    ClipboardItem: class ClipboardItem {},
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    powerMonitor: {
      on: (...args) => powerEvents.on(...args),
    },
    nativeTheme: {
      on() {},
      removeListener() {},
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString('utf8'),
    },
  };

  const context = {
    module,
    exports: module.exports,
    __dirname: path.dirname(MAIN),
    __filename: MAIN,
    process,
    console,
    Buffer,
    URL,
    Response,
    Blob,
    TextDecoder,
    AbortController,
    AbortSignal,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require(id) {
      if (id === 'electron') return electron;
      return fileRequire(id);
    },
  };

  vm.runInNewContext(fs.readFileSync(MAIN, 'utf8'), context, { filename: MAIN });
  return module.exports;
}

test('main.js loads with Electron shell and DesktopShell both wired', () => {
  assert.doesNotThrow(() => loadMainForTest());
});