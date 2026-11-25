'use strict';

// LegacyShell under the same contract every DesktopShell implementation must pass, plus the checks
// specific to this transitional wrapper: the adapter feed becomes the renderer payload on frames
// (with the confirmed place for the controller), the ceiling ∧ confirmation caps mapping, and the
// Ctrl+Alt+C handover between the KWin script and Electron. The adapter factory, the apps/launch/
// files services, the screenshot grab and the shortcut registrar are injected: nothing here touches
// a desktop, Electron or the session bus. drive.frame publishes on the real frames channel; the
// feed → frames wiring is proven by the snapshot test below, so the contract is not vacuous.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runShellContract } = require('./shell.contract');
const { createLegacyShell } = require('../../src/main/platform/shell/legacy-shell');
const { createCapabilities } = require('../../src/main/capabilities');
const adapters = require('../../src/main/adapters');
const inputRegion = require('../../src/main/linux/input-region');
const { BASE_METHODS } = require('../../src/main/linux/screenshot');

const silent = { log() {}, warn() {}, error() {} };
const KDE_WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' };
const X11 = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
const GNOME_WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' };

// `adapter`: what the fake adapter answers differently (its cursor, its apps), for the handle tests.
function makeShell({ env = KDE_WAYLAND, ozone = 'wayland', id = 'kwin', adapter = {} } = {}) {
  const caps = createCapabilities({ platform: 'linux', env, ozone, log: silent });
  const overlay = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    getNativeWindowHandle: () => Buffer.alloc(8),
    setTitle() {},
  };
  const wired = []; // what each adapter factory was given; `adapters` above is the module
  const factory = (deps) => {
    wired.push(deps);
    return {
      id,
      provides: id === 'kwin' ? ['windowTracking', 'appList', 'appClose'] : ['windowTracking'],
      methods: id === 'kwin' ? { screenshot: ['spectacle'] } : {},
      apps: { windows: () => [], closeApps() {} },
      origin: (snap) => (snap.self ? { x: snap.self.x, y: snap.self.y, width: snap.self.w, height: snap.self.h } : null),
      cursor: () => null,
      focus() {}, setZones() {}, stop() {},
      ...adapter,
    };
  };
  const reg = { on: false, fn: null, calls: [] };
  const made = createLegacyShell({
    caps, overlay, log: silent,
    adapters, inputRegion,
    screenshot: { BASE_METHODS, grab: async () => null },
    factories: { [id]: factory },
    apps: { list: async () => [], close: async () => ({ running: false }) },
    launch: { launchables: async () => [], media: async () => true },
    files: { search: async () => [] },
    shortcuts: {
      register(accel, fn) { reg.on = true; reg.fn = fn; reg.calls.push(['register', accel]); return true; },
      unregister(accel) { reg.on = false; reg.calls.push(['unregister', accel]); },
      isRegistered() { return reg.on; },
    },
  });
  return { ...made, caps, reg, adapter: () => wired[0] };
}

runShellContract('LegacyShell', () => makeShell());

test('legacy: an adapter snapshot is delivered as a typed WindowsFrame; devices ride facts; the confirmed place answers overlay.request', async () => {
  const m = makeShell();
  await m.shell.start();
  const seen = [];
  const facts = [];
  m.shell.observe.frames.subscribe((f) => seen.push(f));
  m.shell.observe.facts.subscribe((f) => facts.push(f));
  const snap = {
    fg: 7, taskbar: false, ai: [], game: null, usb: [], plug: null,
    self: { x: 0, y: 0, w: 1920, h: 1040 },
    wins: [{ id: 7, x: 100, y: 50, w: 400, h: 300, max: false }, { id: 8, x: 5000, y: 0, w: 100, h: 100, max: false }],
  };
  m.adapter().onSnapshot(snap);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].rev, 1);
  assert.deepEqual(seen[0].wins, [
    { id: 7, rect: { x: 100, y: 50, w: 400, h: 300 }, max: false },
    { id: 8, rect: { x: 5000, y: 0, w: 100, h: 100 }, max: false },
  ]); // global DIPs, unfiltered: the renderer projection filters
  assert.deepEqual(seen[0].self, { x: 0, y: 0, w: 1920, h: 1040 });
  assert.deepEqual(facts, []); // nothing plugged in: no fact
  assert.deepEqual(await m.shell.overlay.request({ x: 0, y: 0, w: 1920, h: 1040 }), { x: 0, y: 0, w: 1920, h: 1040 });
  // a device change: a fact, not a new frame revision
  m.adapter().onSnapshot({ ...snap, usb: ['STICK'] });
  assert.equal(seen.length, 1);
  assert.deepEqual(facts, [{ kind: 'devices', usb: ['STICK'], plug: null }]);
  await m.shell.stop();
});

test('legacy: caps are the ceiling ∧ the adapter confirmation; the screenshot order follows the live adapter', async () => {
  const m = makeShell();
  const before = m.shell.caps();
  assert.equal(before.backend, 'kwin');
  assert.equal(before.tier, 1);
  assert.equal(before.windows, false);
  assert.deepEqual(before.screenshot, ['portal']);
  assert.deepEqual(before.overlay, { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' });
  await m.shell.start();
  m.adapter().onState(true);
  assert.equal(m.shell.caps().windows, true);
  assert.equal(m.shell.caps().pointer, true);
  assert.deepEqual(m.shell.caps().apps, { list: true, close: true });
  assert.deepEqual(m.shell.caps().screenshot, ['spectacle', 'portal']);
  m.adapter().onState(false);
  assert.equal(m.shell.caps().windows, false);
  assert.deepEqual(m.shell.caps().screenshot, ['portal']);
  assert.equal(m.shell.caps().backend, 'kwin'); // a static fact, whatever the adapter does
  await m.shell.stop();
});

test('legacy: Ctrl+Alt+C belongs to the KWin script while it runs, to Electron when it gives up', async () => {
  const m = makeShell();
  const hotkeys = [];
  m.shell.control.onHotkey.subscribe((id) => hotkeys.push(id));
  await m.shell.start();
  assert.equal(m.reg.on, false); // the script owns it; Electron never registers first
  m.adapter().onState(true);
  assert.equal(m.reg.on, false);
  m.adapter().onState(false);
  assert.equal(m.reg.on, true); // the fallback took over
  m.reg.fn();
  assert.deepEqual(hotkeys, ['stow']);
  m.adapter().onState(true);
  assert.equal(m.reg.on, false); // handed back
  m.adapter().onCommand('toggle');
  assert.deepEqual(hotkeys, ['stow', 'stow']);
  await m.shell.stop();
  assert.equal(m.reg.on, false);
});

test('legacy: where Electron owns the shortcut, it is registered at start and dropped at stop', async () => {
  const m = makeShell({ env: X11, ozone: null, id: 'x11' });
  await m.shell.start();
  assert.equal(m.reg.on, true);
  assert.deepEqual(m.reg.calls[0], ['register', 'Ctrl+Alt+C']);
  await m.shell.stop();
  assert.equal(m.reg.on, false);
});

test('legacy: health mirrors the adapter; stop settles a waiting placement with code stopped', async () => {
  const m = makeShell();
  const seen = [];
  m.shell.health.subscribe((h) => seen.push(h.state));
  await m.shell.start();
  m.adapter().onState(true);
  m.adapter().onState(false);
  const p = m.shell.overlay.request({ x: 9, y: 9, w: 100, h: 100 });
  await m.shell.stop();
  await assert.rejects(p, { code: 'stopped' });
  assert.deepEqual(seen, ['ready', 'degraded', 'stopped']);
});

// The transitional accessors (see the header of legacy-shell.js): what they read is the adapter
// handle, so their forwarding is pinned here before the handle moves to the agent (S4).
test('legacy: the transitional accessors read the adapter handle while it is live', async () => {
  const apps = { windows: () => [], closeApps() {} };
  const m = makeShell({ adapter: { apps, cursor: () => ({ x: 12, y: 34 }) } });
  await m.shell.start();
  m.adapter().onState(true);
  const seen = [];
  m.shell.observe.frames.subscribe((f) => seen.push(f));
  m.adapter().onSnapshot({
    fg: 7, taskbar: false, ai: [], game: null, usb: [], plug: null,
    self: { x: 0, y: 0, w: 1920, h: 1040 },
    wins: [{ id: 7, x: 100, y: 50, w: 400, h: 300, max: false }],
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(m.shell.cursor(), { x: 12, y: 34 });
  assert.equal(m.shell.appWatch(), apps); // the very object the adapter offers
  m.shell.refresh();
  assert.equal(seen.length, 2); // the same picture again, as when her window moved
  await m.shell.stop();
  assert.equal(m.shell.appWatch(), null); // the adapter stopped: it offers nothing
});

test('legacy: with no adapter the transitional accessors answer nothing', async () => {
  const m = makeShell({ env: GNOME_WAYLAND }); // Tier 2: startAdapters hands back the idle handle
  await m.shell.start();
  const seen = [];
  m.shell.observe.frames.subscribe((f) => seen.push(f));
  assert.equal(m.shell.cursor(), null);
  assert.equal(m.shell.appWatch(), null);
  m.shell.refresh();
  assert.deepEqual(seen, []); // nothing to send again
  await m.shell.stop();
});