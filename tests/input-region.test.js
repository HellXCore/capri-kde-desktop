'use strict';

// The input region: which mechanism reaches her window, and what is loaded to do it. The ceiling
// names the mechanism; the display server her window really is on says whether it can be reached.
// libX11/libXext must never be opened for a native Wayland window.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputRegion, chooseBackend, WAYLAND_SHAPE_SINCE } = require('../src/main/linux/input-region');
const { createCapabilities } = require('../src/main/capabilities');

const silent = { log() {}, warn() {} };
const capsFor = (env, ozone) => createCapabilities({ platform: 'linux', env, ozone, dev: true, log: silent });
const WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };
const X11 = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
const KDE = { XDG_CURRENT_DESKTOP: 'KDE' };
const GNOME = { XDG_CURRENT_DESKTOP: 'GNOME' };

// A window that answers what the region asks of it, and keeps what it was told.
function fakeOverlay() {
  const told = { shapes: [], ignore: [], events: new Set() };
  return {
    told,
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    setShape: (r) => told.shapes.push(r),
    setIgnoreMouseEvents: (v) => told.ignore.push(v),
    webContents: { invalidate() {} },
    on: (e) => told.events.add(e),
    removeListener: (e) => told.events.delete(e),
  };
}

// The exact-shape backend, or null where koffi/libXext cannot be had. Counts every call.
function shapeFactory(result = 'backend') {
  const calls = [];
  const make = (overlay) => {
    calls.push(overlay);
    return result === null ? null : { set() {}, reapply() {}, close() {} };
  };
  make.calls = calls;
  return make;
}

const region = (caps, over = {}) => createInputRegion({
  overlay: over.overlay || fakeOverlay(),
  mechanism: caps.mechanisms().input,
  server: caps.session,
  xshape: over.xshape || shapeFactory(),
  log: silent,
  ...over,
});

// [name, env, ozone, mechanism, kind with the shape extension, kind without it]
const INTERSECTIONS = [
  ['wayland-kde', { ...WAYLAND, ...KDE }, 'wayland', 'toggle', 'toggle', 'toggle'],
  ['wayland-generic', { ...WAYLAND, ...GNOME }, 'wayland', 'none', 'none', 'none'],
  ['xwayland-kde', { ...WAYLAND, ...KDE }, 'x11', 'xshape', 'xshape', 'bounding'],
  ['xwayland-compat', { ...WAYLAND, ...GNOME }, 'x11', 'xshape', 'xshape', 'bounding'],
  ['x11', { ...X11, ...KDE }, null, 'xshape', 'xshape', 'bounding'],
  ['none', KDE, null, 'none', 'none', 'none'],
];

test('the mechanism is the ceiling\'s, and the kind is what can reach that window', () => {
  for (const [name, env, ozone, mechanism, withShape, without] of INTERSECTIONS) {
    const caps = capsFor(env, ozone);
    assert.equal(caps.mechanisms().input, mechanism, name);
    for (const [available, want] of [[true, withShape], [false, without]]) {
      assert.equal(chooseBackend({ mechanism, server: caps.session, xshape: available }), want, `${name} shape=${available}`);
      const r = region(caps, { xshape: shapeFactory(available ? 'backend' : null) });
      assert.equal(r.kind, want, `${name} shape=${available}`);
      r.close();
    }
  }
});

test('the exact shape is asked for only where it can reach the window', () => {
  for (const [name, env, ozone, mechanism] of INTERSECTIONS) {
    const caps = capsFor(env, ozone);
    const xshape = shapeFactory();
    const r = region(caps, { xshape });
    const wanted = mechanism === 'xshape' && ['x11', 'xwayland'].includes(caps.session);
    assert.equal(xshape.calls.length, wanted ? 1 : 0, `${name}: libX11/libXext opened where it cannot be used`);
    r.close();
  }
});

test('a Wayland window never opens the X libraries, whatever the shape factory is', () => {
  for (const desktop of [KDE, GNOME]) {
    const xshape = shapeFactory();
    const r = region(capsFor({ ...WAYLAND, ...desktop }, 'wayland'), { xshape });
    assert.equal(xshape.calls.length, 0);
    assert.ok(['toggle', 'none'].includes(r.kind));
    r.close();
  }
});

test('CAPRI_WAYLAND_INPUT still speaks on native Wayland, and only there', () => {
  const caps = capsFor({ ...WAYLAND, ...GNOME }, 'wayland');
  for (const asked of ['shape', 'toggle', 'none']) {
    const r = region(caps, { env: { CAPRI_WAYLAND_INPUT: asked } });
    assert.equal(r.kind, asked, asked);
    r.close();
  }
  const x11 = capsFor({ ...X11, ...KDE }, null);
  const r = region(x11, { env: { CAPRI_WAYLAND_INPUT: 'toggle' } });
  assert.equal(r.kind, 'xshape');
  r.close();
  // Electron's own Wayland shape is not known yet: a newer major alone does not ask for it
  assert.equal(WAYLAND_SHAPE_SINCE, null);
  const newer = region(caps, { env: {}, electronMajor: 99 });
  assert.equal(newer.kind, 'none');
  newer.close();
});

test('a mechanism named for another display server cannot reach this window', () => {
  // a forced policy is not the window: X calls cannot reach a Wayland window, and a Wayland
  // mechanism has nothing to follow on an X one. Neither may load the X libraries.
  const wayland = capsFor({ ...WAYLAND, ...KDE, CAPRI_FORCE_MODE: 'xwayland:kde' }, 'wayland');
  assert.equal(wayland.session, 'wayland');
  assert.equal(wayland.mechanisms().input, 'xshape');
  const a = shapeFactory();
  const ra = region(wayland, { xshape: a });
  assert.equal(ra.kind, 'none');
  assert.equal(a.calls.length, 0);
  ra.close();

  const x11 = capsFor({ ...X11, ...KDE, CAPRI_FORCE_MODE: 'wayland:kde' }, null);
  assert.equal(x11.session, 'x11');
  assert.equal(x11.mechanisms().input, 'toggle');
  const b = shapeFactory();
  const rb = region(x11, { xshape: b });
  assert.equal(rb.kind, 'none');
  assert.equal(b.calls.length, 0);
  rb.close();
});

test('toggle: click-through from the start, the mouse taken only over something of hers', () => {
  const overlay = fakeOverlay();
  const r = region(capsFor({ ...WAYLAND, ...KDE }, 'wayland'), { overlay });
  assert.equal(r.kind, 'toggle');
  assert.deepEqual(overlay.told.ignore, [true]); // nothing of hers drawn yet
  assert.equal(r.stats().pointers, 0);
  r.pointer({ x: 10, y: 10 });
  r.set([{ x: 0, y: 0, width: 100, height: 100 }], 1);
  assert.deepEqual(overlay.told.ignore, [true, false]);
  assert.equal(r.stats().pointers, 1);
  r.close();
  assert.equal(overlay.told.events.size, 0);
});

test('bounding and none: nothing is claimed that cannot be done', () => {
  const shaped = fakeOverlay();
  const r = region(capsFor({ ...X11, ...KDE }, null), { overlay: shaped, xshape: shapeFactory(null) });
  assert.equal(r.kind, 'bounding');
  assert.equal(shaped.told.shapes.length, 1); // "nowhere", not the whole window
  r.close();

  const bare = fakeOverlay();
  const none = region(capsFor({ ...WAYLAND, ...GNOME }, 'wayland'), { overlay: bare });
  assert.equal(none.kind, 'none');
  none.set([{ x: 0, y: 0, width: 10, height: 10 }], 1);
  none.pointer({ x: 1, y: 1 });
  none.reapply();
  assert.equal(none.stats(), null);
  assert.deepEqual(bare.told.shapes, []);
  assert.deepEqual(bare.told.ignore, []);
  none.close();
});