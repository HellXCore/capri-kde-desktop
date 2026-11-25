'use strict';

// Which watcher a mode may start, and what it is allowed to report. A fake factory stands in for the
// real ones, so this runs without Electron and without a desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAdapters, FACTORIES, snapshotToDip } = require('../src/main/adapters');
const { createCapabilities, ADAPTERS } = require('../src/main/capabilities');

const silent = { log() {}, warn() {} };
const overlay = { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }) };
const env = (over = {}) => ({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', ...over });
const capsFor = (e, ozone) => createCapabilities({ platform: 'linux', env: e, ozone, log: silent });

// A watcher that reports what it is told, and may refuse before it has even returned itself.
function fake(id, { provides, origin = null, sync = null }, calls) {
  return (deps) => {
    calls.push({ id, deps });
    if (sync !== null) deps.onState(sync);
    return { id, provides, origin, stop() { calls.stopped = (calls.stopped || 0) + 1; } };
  };
}

const run = (caps, factories, { onFrame = () => {}, onFact = () => {} } = {}) => startAdapters({
  caps, overlay, session: caps.session, area: null, onFrame, onFact, log: silent, factories,
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
    const a = run(caps, { kwin: fake('kwin', { provides: ['windowTracking'] }, calls) }, { onFrame: () => assert.fail('a frame with no adapter') });
    assert.equal(calls.length, 0);
    assert.equal(caps.has('windowTracking'), false);
    assert.equal(a.frame(), null);
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
  run(caps, { x11: fake('x11', { provides: ['windowTracking'] }, calls), kwin: () => assert.fail('the KWin script in an X11 session') });
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
    x11: fake('x11', { provides: ['windowTracking'] }, []),
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

test('the feed assembles a global-DIP frame with a revision; the confirmed place rides it', () => {
  const caps = capsFor(env({ XDG_CURRENT_DESKTOP: 'KDE' }), 'wayland');
  const calls = [];
  const frames = [];
  const facts = [];
  const a = run(caps, {
    kwin: fake('kwin', {
      provides: ['windowTracking', 'appList', 'appClose'],
      origin: (snap) => (snap.self ? { x: snap.self.x, y: snap.self.y, width: snap.self.w, height: snap.self.h } : null),
    }, calls),
  }, { onFrame: (f) => frames.push(f), onFact: (f) => facts.push(f) });

  const snap = {
    fg: 7, self: { x: 100, y: 50, w: 800, h: 600 },
    wins: [{ id: 7, x: 150, y: 120, w: 400, h: 300, max: false }, { id: 8, x: 2000, y: 50, w: 100, h: 100, max: false }],
  };
  calls[0].deps.onSnapshot(snap);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rev, 1);
  // global DIPs, every window kept: filtering to the overlay's screen is the renderer projection's job
  assert.deepEqual(frames[0].wins.map((w) => w.rect), [{ x: 150, y: 120, w: 400, h: 300 }, { x: 2000, y: 50, w: 100, h: 100 }]);
  assert.deepEqual(frames[0].self, { x: 100, y: 50, w: 800, h: 600 });
  assert.deepEqual(a.frame().self, { x: 100, y: 50, w: 800, h: 600 });
  assert.deepEqual(facts, []);
  a.refresh();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].rev, 1); // the same picture again, as when her window moved
  a.stop();
  assert.equal(calls.stopped, 1);
});

// ---------- the conversion at the backend boundary ----------

const display = (x, y, w, h, scale) => ({ id: 1, bounds: { x, y, w, h }, workArea: { x, y, w, h }, scale });

test('snapshotToDip: window rects converted by the display at their centre, the rest rides along', () => {
  const snap = {
    fg: 7, taskbar: false, ai: ['chatgpt'], game: null, usb: [], plug: null,
    wins: [
      { id: 7, x: 300, y: 150, w: 900, h: 600, max: false },
      { id: 8, x: 3000, y: 150, w: 900, h: 600, max: true },
    ],
  };
  const out = snapshotToDip(snap, [display(0, 0, 1920, 1080, 1), display(1920, 0, 1280, 720, 1.5)]);
  assert.deepEqual(out.wins, [
    { id: 7, x: 300, y: 150, w: 900, h: 600, max: false },
    { id: 8, x: 2000, y: 100, w: 600, h: 400, max: true },
  ]);
  assert.equal(out.fg, 7);
  assert.deepEqual(out.ai, ['chatgpt']);
  assert.notEqual(out, snap);
  assert.deepEqual(snap.wins[1], { id: 8, x: 3000, y: 150, w: 900, h: 600, max: true }); // the input is untouched
});

test('snapshotToDip: fractions kept; empty wins; null displays passes the snapshot through', () => {
  const out = snapshotToDip({ fg: 0, wins: [{ id: 1, x: 100, y: 100, w: 300, h: 200, max: false }] }, [display(0, 0, 1280, 720, 1.5)]);
  assert.deepEqual(out.wins[0], { id: 1, x: 100 / 1.5, y: 100 / 1.5, w: 200, h: 200 / 1.5, max: false });
  assert.deepEqual(snapshotToDip({ fg: 0, wins: [] }, [display(0, 0, 100, 100, 1)]).wins, []);
  const dip = { fg: 3, wins: [{ id: 3, x: 1.5, y: 2.5, w: 3, h: 4, max: false }] };
  assert.equal(snapshotToDip(dip, null), dip); // already DIPs: the very same snapshot
});

test('the feed no longer converts: an adapter\'s DIP snapshot arrives as it is', () => {
  // Before the conversion moved to the boundary this threw: the feed converted non-DIP
  // snapshots itself and asked Electron for displays. Now the adapter hands DIPs over.
  const caps = capsFor({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, null);
  const calls = [];
  const frames = [];
  const a = run(caps, { x11: fake('x11', { provides: ['windowTracking'] }, calls) }, { onFrame: (f) => frames.push(f) });
  calls[0].deps.onSnapshot({ fg: 7, wins: [{ id: 7, x: 123.5, y: 45.25, w: 400, h: 300, max: false }] });
  assert.deepEqual(frames[0].wins[0].rect, { x: 123.5, y: 45.25, w: 400, h: 300 });
  a.stop();
});