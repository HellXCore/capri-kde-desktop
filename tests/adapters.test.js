'use strict';

// Which watcher a mode may start, and what it is allowed to report. A fake factory stands in for the
// real ones, so this runs without Electron and without a desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAdapters, FACTORIES } = require('../src/main/adapters');
const { createCapabilities, ADAPTERS } = require('../src/main/capabilities');

const silent = { log() {}, warn() {} };
const overlay = { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }) };
const env = (over = {}) => ({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', ...over });
const capsFor = (e, ozone) => createCapabilities({ platform: 'linux', env: e, ozone, log: silent });

// A watcher that reports what it is told, and may refuse before it has even returned itself.
function fake(id, { provides, units = 'dip', origin = null, sync = null }, calls) {
  return (deps) => {
    calls.push({ id, deps });
    if (sync !== null) deps.onState(sync);
    return { id, units, provides, origin, stop() { calls.stopped = (calls.stopped || 0) + 1; } };
  };
}

const run = (caps, factories, onUpdate = () => {}) => startAdapters({
  caps, overlay, session: caps.session, area: null, onUpdate, log: silent, factories,
});

test('every declared adapter has a factory, and no factory is undeclared', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), Object.keys(FACTORIES).sort());
});

test('a mode with no adapters starts nothing and reports nothing', () => {
  for (const [e, ozone, mode] of [
    [env({ XDG_CURRENT_DESKTOP: 'GNOME' }), 'wayland', 'wayland-generic'],
    [env({ XDG_CURRENT_DESKTOP: 'GNOME' }), 'x11', 'xwayland-compat'],
  ]) {
    const caps = capsFor(e, ozone);
    assert.equal(caps.mode, mode);
    const calls = [];
    const a = run(caps, { kwin: fake('kwin', { provides: ['windowTracking'] }, calls) }, () => assert.fail('a snapshot with no adapter'));
    assert.equal(calls.length, 0);
    assert.equal(caps.has('windowTracking'), false);
    assert.deepEqual(a.origin(), null);
    assert.deepEqual(a.cursor(), null);
    a.focus(true); a.setZones([]); a.refresh(); a.stop(); // all no-ops
  }
});

test('the KDE modes start the KWin adapter, and it reports the three features it provides', () => {
  for (const ozone of ['wayland', 'x11']) {
    const caps = capsFor(env({ XDG_CURRENT_DESKTOP: 'KDE' }), ozone);
    const calls = [];
    run(caps, { kwin: fake('kwin', { provides: ['windowTracking', 'appList', 'appClose'] }, calls), x11: () => assert.fail('the X11 watcher in a KDE mode') });
    assert.equal(calls[0].id, 'kwin');
    calls[0].deps.onState(true);
    assert.deepEqual(caps.all(), {
      windowTracking: true, appList: true, appClose: true,
      appLaunch: true, mediaKeys: true, autostart: false, ollamaInstall: false, ollamaLaunch: true,
    });
    calls[0].deps.onState(false); // the script went: everything it gave goes with it
    assert.equal(caps.has('windowTracking'), false);
    assert.equal(caps.has('appList'), false);
    assert.equal(caps.has('appClose'), false);
  }
});

test('mode x11 starts the X11 adapter, which provides window tracking and nothing else', () => {
  const caps = capsFor({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, null);
  assert.equal(caps.mode, 'x11');
  const calls = [];
  run(caps, { x11: fake('x11', { provides: ['windowTracking'], units: 'x-physical' }, calls), kwin: () => assert.fail('the KWin script in an X11 session') });
  calls[0].deps.onState(true);
  assert.equal(caps.has('windowTracking'), true);
  assert.equal(caps.has('appList'), false);
  assert.equal(caps.has('appClose'), false);
});

test('the KWin half is never loaded where its adapter may not run', () => {
  const kwin = require.resolve('../src/main/linux/kwin-bridge');
  for (const [e, ozone] of [
    [env({ XDG_CURRENT_DESKTOP: 'GNOME' }), 'wayland'],
    [env({ XDG_CURRENT_DESKTOP: 'GNOME' }), 'x11'],
    [{ XDG_CURRENT_DESKTOP: 'KDE' }, null],
  ]) {
    const caps = capsFor(e, ozone);
    assert.deepEqual(caps.adapters(), []);
    run(caps, FACTORIES); // the real factories: nothing may be created, nothing loaded
  }
  const x11 = capsFor({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, null);
  run(x11, {
    x11: fake('x11', { provides: ['windowTracking'], units: 'x-physical' }, []),
    kwin: () => assert.fail('the KWin script in an X11 session'),
  });
  assert.equal(require.cache[kwin], undefined, 'the KWin half was loaded for a desktop that may not run it');
});

test('a watcher that refuses synchronously is still heard', () => {
  const caps = capsFor(env({ XDG_CURRENT_DESKTOP: 'KDE' }), 'wayland');
  const calls = [];
  const seen = [];
  startAdapters({
    caps, overlay, session: caps.session, onUpdate: () => {}, log: silent,
    onState: (ok, adapter) => seen.push([ok, adapter.id]),
    factories: { kwin: fake('kwin', { provides: ['windowTracking', 'appList', 'appClose'], sync: false }, calls) },
  });
  assert.deepEqual(seen, [[false, 'kwin']]);
  assert.equal(caps.has('windowTracking'), false);
});

test('the feed places a snapshot from the adapter that knows where the overlay is', () => {
  const caps = capsFor(env({ XDG_CURRENT_DESKTOP: 'KDE' }), 'wayland');
  const calls = [];
  const updates = [];
  const a = run(caps, {
    kwin: fake('kwin', {
      provides: ['windowTracking', 'appList', 'appClose'],
      origin: (snap) => (snap.self ? { x: snap.self.x, y: snap.self.y, width: snap.self.w, height: snap.self.h } : null),
    }, calls),
  }, (data) => updates.push(data));

  const snap = {
    fg: 7, self: { x: 100, y: 50, w: 800, h: 600 },
    wins: [{ id: 7, x: 150, y: 120, w: 400, h: 300, max: false }, { id: 8, x: 2000, y: 50, w: 100, h: 100, max: false }],
  };
  calls[0].deps.onSnapshot(snap);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].wins, [{ id: 7, x: 50, y: 70, w: 400, h: 300, max: false }]); // the other screen's window is left out
  assert.deepEqual(a.origin(), { x: 100, y: 50, width: 800, height: 600 });
  a.refresh();
  assert.equal(updates.length, 2); // the same snapshot again, as when her window moved
  a.stop();
  assert.equal(calls.stopped, 1);
});