'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FEATURES, detect, linuxSession, createCapabilities } = require('../src/main/capabilities');

const make = (platform = 'linux', extra = {}) => createCapabilities({ platform, env: {}, ...extra });
const KDE_WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };

test('Linux: nothing system-dependent is on until an adapter reports it', () => {
  const caps = make('linux', { env: { DISPLAY: ':0' } });
  assert.equal(FEATURES.some((name) => caps.has(name)), false);
  assert.deepEqual(caps.forRenderer(), {
    windows: false, possess: false, closeApps: false, launchApps: false, mediaKeys: false, ollamaLaunch: false,
  });
  assert.equal(caps.session, 'x11');
});

test('Linux: the window watcher (X11 or KWin) turns window tracking on and off', () => {
  const caps = make('linux', { env: KDE_WAYLAND });
  assert.equal(caps.session, 'xwayland'); // Capri in XWayland: the KWin script's session
  assert.equal(caps.has('windowTracking'), false); // before the script's first update
  const heard = [];
  caps.onChange((name, value) => heard.push([name, value]));

  caps.set('windowTracking', true); // startKWinWatch: onState(true) on the first update
  caps.set('windowTracking', true);
  assert.equal(caps.has('windowTracking'), true);
  assert.equal(caps.forRenderer().windows, true);
  assert.equal(caps.forRenderer().possess, true);
  assert.equal(caps.forRenderer().mediaKeys, false); // the rest stays off

  caps.set('windowTracking', false); // the script went silent, or the bus was lost
  assert.equal(caps.forRenderer().possess, false);
  assert.deepEqual(heard, [['windowTracking', true], ['windowTracking', false]]);
});

test('Linux: nothing system-dependent yet, autostart included', () => {
  const caps = make('linux', { env: { DISPLAY: ':0' } });
  assert.equal(FEATURES.some((name) => caps.has(name)), false);
  assert.equal(caps.session, 'x11');
});

test('Linux session: X11, XWayland, native Wayland, none', () => {
  assert.equal(linuxSession({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }), 'x11');
  assert.equal(linuxSession({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'xwayland');
  assert.equal(linuxSession({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':1' }), 'xwayland');
  assert.equal(linuxSession({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland');
  assert.equal(linuxSession({}), null);
});

//test('an adapter turns a feature on or off, listeners hear only real changes', () => {
//  const caps = make('darwin');
//  const heard = [];
//  const off = caps.onChange((name, value) => heard.push([name, value]));
//  caps.set('windowTracking', true); // e.g. a macOS watcher that started (CAPRI-09)
//  caps.set('windowTracking', true);
//  assert.equal(caps.has('windowTracking'), true);
//  assert.equal(caps.forRenderer().windows, true);
//  assert.equal(caps.forRenderer().possess, true);
//  caps.set('windowTracking', false); // it gave up
//  assert.equal(caps.forRenderer().possess, false);
//  off();
//  caps.set('windowTracking', true);
//  assert.deepEqual(heard, [['windowTracking', true], ['windowTracking', false]]);
//});

//test('unknown features are refused, the renderer only gets booleans', () => {
//  const caps = make('win32');
//  assert.throws(() => caps.has('teleport'), /unknown capability/);
//  assert.throws(() => caps.set('teleport', true), /unknown capability/);
//  for (const value of Object.values(caps.forRenderer())) assert.equal(typeof value, 'boolean');
//  assert.equal(caps.all().mediaKeys, true);
//});

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
