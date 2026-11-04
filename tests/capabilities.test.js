'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FEATURES, detect, linuxSession, createCapabilities } = require('../src/main/capabilities');

const make = (platform = 'linux', extra = {}) => createCapabilities({ platform, env: {}, ...extra });
const KDE_WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };

test('Linux: base features are on, dynamic features wait for adapter', () => {
  const caps = make('linux', { env: { DISPLAY: ':0' } });
  
  // Base Linux features is enabled
  assert.equal(caps.has('appLaunch'), true);
  assert.equal(caps.has('mediaKeys'), true);
  assert.equal(caps.has('ollamaLaunch'), true);

  // Unsupported extended linux features,
  // witch is disabled by default
  assert.equal(caps.has('windowTracking'), false);
  assert.equal(caps.has('appList'), false);
  assert.equal(caps.has('appClose'), false);
  assert.equal(caps.has('autostart'), false);

  assert.deepEqual(caps.forRenderer(), {
    windows: false,
    possess: false,
    closeApps: false,
    launchApps: true,
    mediaKeys: true,
    ollamaLaunch: true,
  });
  assert.equal(caps.session, 'x11');
});

test('Linux: the window watcher (X11 or KWin) turns window tracking on and off', () => {
  const caps = make('linux', { env: KDE_WAYLAND });
  assert.equal(caps.session, 'xwayland');
  assert.equal(caps.has('windowTracking'), false);
  const heard = [];
  caps.onChange((name, value) => heard.push([name, value]));
  // Extended linux features witch is enabled by adepters
  caps.set('windowTracking', true);
  caps.set('windowTracking', true);
  assert.equal(caps.has('windowTracking'), true);
  assert.equal(caps.forRenderer().windows, true);
  assert.equal(caps.forRenderer().possess, true);
  // Adapter features like "closeApps" are disabled when isn't KDE environment
  assert.equal(caps.forRenderer().closeApps, false);

  caps.set('windowTracking', false);
  assert.equal(caps.forRenderer().possess, false);
  assert.deepEqual(heard, [['windowTracking', true], ['windowTracking', false]]);
});

test('Linux: autostart and window tracking are off initially', () => {
  const caps = make('linux', { env: { DISPLAY: ':0' } });
  assert.equal(caps.has('autostart'), false);
  assert.equal(caps.has('windowTracking'), false);
  assert.equal(caps.session, 'x11');
});

test('Linux session: X11, XWayland, native Wayland, none', () => {
  assert.equal(linuxSession({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }), 'x11');
  assert.equal(linuxSession({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'xwayland');
  assert.equal(linuxSession({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':1' }), 'xwayland');
  assert.equal(linuxSession({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland');
  assert.equal(linuxSession({}), null);
});

function load(file, platform, electron, extra = {}, globals = {}) {
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/main', file);
  const context = {
    module, exports: module.exports, __dirname: path.dirname(filename), process: { platform, env: {}, pid: 1 }, console, Buffer, ...globals,
    require(id) {
      if (id === 'electron') return electron;
      if (id in extra) return extra[id];
      return require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}
