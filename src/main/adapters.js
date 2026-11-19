'use strict';

// Where the environment-specific watchers are made. The mode says which adapters may run
// (capabilities.js); this is the only place that creates them and the only place that knows their
// names. Everything above asks the object returned here, never the watcher behind it.
//
// An adapter says what it gives and how it measures:
//   id, units ('dip' | 'x-physical'), provides: [feature…], stop()
//   origin?(snapshot)  where the overlay really is, when only the compositor knows
//   cursor?()          where the pointer really is, in screen DIPs
//   focus?(on)         the keyboard for the overlay, and back
//   setZones?(rects)   where the overlay takes the pointer
// A watcher's own guard is a defensive check: the mode has already decided it may run.

const { createFeed, toDip } = require('./windows');

const OVERLAY_TITLE = 'capri-overlay';

// KWin reports every window, native Wayland ones included, and looks after the overlay itself:
// its place, the keyboard, the pointer, closing apps. Natively its logical pixels are Electron's
// DIPs; through XWayland they are the X screen's pixels, as with the X11 watcher.
function kwinAdapter({ overlay, session, area, onSnapshot, onState, onCommand, onPointer }) {
  const path = require('node:path');
  const { app, screen } = require('electron');
  const { startKWinWatch } = require('./linux/kwin-bridge');
  const units = session === 'wayland' ? 'dip' : 'x-physical';

  // KWin tells the overlay from the other windows by its process and its title
  overlay.setTitle(OVERLAY_TITLE);

  const watch = startKWinWatch({
    session,
    scriptDir: path.join(app.getPath('userData'), 'kwin'),
    getSelf: () => {
      // Native Wayland: where she should be (a client cannot place its own window, the script does)
      if (units === 'dip' && area) {
        const a = area();
        if (a) return { pid: process.pid, title: OVERLAY_TITLE, rect: { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) } };
      }
      // where her window is, in the X screen's pixels: its DIPs times the scale of its screen
      const b = overlay.getBounds();
      const k = (screen.getDisplayMatching(b) || {}).scaleFactor || 1;
      return { pid: process.pid, title: OVERLAY_TITLE, rect: { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.width * k), h: Math.round(b.height * k) } };
    },
    onSnapshot, onState, onCommand, onPointer,
  });

  return {
    id: 'kwin',
    units,
    provides: ['windowTracking', 'appList', 'appClose'],
    // Spectacle takes the picture from KWin itself; where the script is not running, the base
    // stack does it instead
    methods: { screenshot: ['spectacle'] },
    apps: {
      windows: () => watch.windows(),
      closeApps: (pids) => watch.closeApps(pids),
    },
    origin: units === 'dip'
      ? (snap) => (snap.self ? { x: snap.self.x, y: snap.self.y, width: snap.self.w, height: snap.self.h } : null)
      : null,
    focus: (on) => watch.focus(on),
    setZones: (rects) => watch.setZones?.(rects),
    cursor: () => {
      const at = watch.cursor();
      if (!at) return null;
      const dip = toDip({ x: at.x, y: at.y, w: 0, h: 0 }, units);
      return { x: dip.x, y: dip.y };
    },
    stop: watch.stop,
  };
}

// A real X11 session, read through the window manager (EWMH). It lists no apps and owns no shortcut.
function x11Adapter({ overlay, session, onSnapshot, onState }) {
  const { startX11Watch } = require('./linux/x11-watch');
  const x11 = require('./linux/x11');
  const watch = startX11Watch({
    session,
    self: { id: x11.selfXid(overlay.getNativeWindowHandle()) },
    onSnapshot, onState,
  });
  return { id: 'x11', units: 'x-physical', provides: ['windowTracking'], stop: watch.stop };
}

const FACTORIES = { kwin: kwinAdapter, x11: x11Adapter };

const IDLE = {
  stop() {}, refresh() {}, origin: () => null, cursor: () => null, focus() {}, setZones() {},
  methods: () => ({}), apps: () => null,
};

// One adapter feeds the overlay: the modes name one each. `onState(ok, adapter)` runs after what the
// adapter provides has been written to caps, so whoever listens already sees the new state.
function startAdapters({
  caps, overlay, session, area = null, onUpdate,
  onState = () => {}, onCommand = () => {}, onPointer = () => {}, log = console, factories = FACTORIES,
}) {
  const ids = caps.adapters();
  if (!ids.length) return IDLE;
  const [id] = ids;
  if (ids.length > 1) log.warn?.(`[capri] mode ${caps.mode} names ${ids.length} adapters; only ${id} feeds the overlay`);
  const make = factories[id];
  if (!make) {
    log.warn?.(`[capri] no adapter named ${id}`);
    return IDLE;
  }

  let adapter = null;
  let live = false; // it has said it is running: only then does it offer anything of its own
  const early = []; // a watcher may refuse synchronously, before it has returned itself
  const feed = createFeed({
    overlay,
    onUpdate,
    toDip: (win) => toDip(win, adapter.units),
    origin: (snap) => (adapter.origin ? adapter.origin(snap) : null),
  });
  const report = (ok) => {
    live = Boolean(ok);
    for (const feature of adapter.provides) caps.set(feature, ok);
    onState(ok, adapter);
  };

  adapter = make({
    overlay, session, area,
    onSnapshot: feed.push,
    onState: (ok) => (adapter ? report(ok) : early.push(ok)),
    onCommand, onPointer,
  });
  for (const ok of early) report(ok);

  return {
    stop: () => { live = false; adapter.stop(); },
    refresh: feed.send,
    origin: feed.origin,
    cursor: () => adapter.cursor?.() ?? null,
    focus: (on) => adapter.focus?.(on),
    setZones: (rects) => adapter.setZones?.(rects),
    // what it offers beyond the base methods, and the windows it sees: nothing while it is down
    methods: () => (live ? adapter.methods || {} : {}),
    apps: () => (live ? adapter.apps || null : null),
  };
}

module.exports = { startAdapters, FACTORIES, OVERLAY_TITLE };