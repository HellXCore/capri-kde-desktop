'use strict';

// LegacyShell: the DesktopShell port over the adapters that exist today, until the platform agent
// replaces them. Everything that knows about display servers, KWin, X11, the screenshot stack or
// the global shortcut lives here; the composition root only wires dependencies and consumes the port.
//
// The legacy pieces are handed in rather than required from here: this file is type-checked, and a
// static require would pull the untyped modules it wraps into the checked program. Wiring them is
// the root's job.
//
// Transitional deviations from the port, which go away with this file:
//   - observe.pointer carries overlay-local coordinates from the compositor script, not global DIPs;
//   - os.screenshot resolves the image the capture stack returns, not a Buffer: its consumers use it
//     as it is, and encoding it here would be a behaviour change;
//   - cursor(), refresh(), appWatch() and inputKind() are accessors the port has no equivalent for
//     yet: the global cursor query, the feed re-send after the overlay moved, the open-app window
//     source, and the resolved input variant for the controller's shape factory.
//
// `drive` is the contract-test seam: frame() publishes on the real frames channel, stall() holds real
// requests until release(). Production uses only `shell`.

const STOW_ACCEL = 'Ctrl+Alt+C';

/** @type {Record<string, 'xshape' | 'toggle' | 'passthrough'>} */
const INPUT = { xshape: 'xshape', bounding: 'xshape', shape: 'xshape', toggle: 'toggle', none: 'passthrough' };

/** @type {{ register(accel: string, fn: () => void): boolean, unregister(accel: string): void, isRegistered(accel: string): boolean }} */
const NO_SHORTCUTS = { register: () => false, unregister() {}, isRegistered: () => false };

const stoppedError = () => Object.assign(new Error('the shell is stopped'), { code: 'stopped' });

/**
 * @param {any} a
 * @param {any} b
 */
const sameRect = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

// Subscribers hear values synchronously, in subscription order, over a snapshot of the list; last()
// replays the newest value so a late subscriber can catch up. Subscribing itself never replays.
function observable() {
  /** @type {Set<(value: any) => void>} */
  const subs = new Set();
  /** @type {any} */ let last; // frames carry WindowsFrame; pointer is still legacy-local (see the header)
  return {
    /** @param {(value: any) => void} fn */
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    last: () => last,
    /** @param {any} value */
    publish(value) { last = value; for (const fn of [...subs]) fn(value); },
    clear() { subs.clear(); },
  };
}

/** @param {string} what */
const notWired = (what) => async () => {
  throw Object.assign(new Error(`${what} is not wired into this shell`), { code: 'not-wired' });
};

/**
 * @param {{
 *   caps: any,                    // capabilities.js: the ceiling ∧ the adapter's confirmations
 *   overlay: { isDestroyed(): boolean, getBounds(): any, getNativeWindowHandle(): any, setTitle(t: string): void },
 *   adapters: any,                // { startAdapters, FACTORIES }
 *   inputRegion: any,             // { chooseBackend }
 *   screenshot: any,              // { BASE_METHODS, grab }
 *   apps: any,                    // { list, close }
 *   launch?: any,                 // { launchables, media }
 *   files?: any,                  // { search }
 *   area?: (() => any) | null,    // where the overlay should be (only the compositor can place it)
 *   log?: any,
 *   factories?: any,              // adapter factories, for tests
 *   shortcuts?: { register(accel: string, fn: () => void): boolean, unregister(accel: string): void, isRegistered(accel: string): boolean },
 * }} deps
 */
function createLegacyShell({
  caps, overlay, adapters, inputRegion, screenshot, apps,
  launch = null, files = null, area = null, log = console,
  factories = adapters.FACTORIES, shortcuts = NO_SHORTCUTS,
}) {
  // Static facts, decided once: the contract pins caps().backend across start/stop.
  const [adapterId] = caps.adapters();
  const backend = adapterId === 'kwin' || adapterId === 'x11' ? adapterId : 'generic';
  const adapterShortcut = caps.mechanisms().shortcut === 'adapter';
  const nativeWayland = caps.facts.server === 'wayland';
  // The exact shape may still fall back to the bounding one inside the strategy (koffi/libXext).
  const inputKind = inputRegion.chooseBackend({
    mechanism: caps.mechanisms().input, server: caps.session, xshape: true,
  });
  const input = INPUT[inputKind] || 'passthrough';

  let state = 'idle'; // idle | starting | ready | degraded | stopped; health mirrors the adapter
  // What startAdapters() hands back; adapters.js is untyped, so its shape is said here.
  /** @type {{
   *   stop(): void, refresh(): void,
   *   frame(): import('../../core/ports').WindowsFrame | null,
   *   cursor(): { x: number, y: number } | null,
   *   focus(on: boolean): void, setZones(rects: any[]): void,
   *   methods(): { screenshot?: string[] },
   *   apps(): { windows(): any[], closeApps(pids: number[]): void } | null,
   * } | null} */
  let handle = null;  // what startAdapters returned
  let stalled = false;
  /** @type {Set<any>} */ const pending = new Set(); // in flight; stop() rejects them all
  /** @type {Set<any>} */ const held = new Set();    // parked by drive.stall()
  /** @type {Set<any>} */ const waiters = new Set(); // overlay.request() awaiting a confirmed place
  /** @type {Set<string>} */ const extraAccels = new Set(); // registered through control.hotkey()

  const health = observable();
  const frames = observable();
  const pointer = observable();
  const facts = observable(); // devices (usb / plug), reported when they change
  const onHotkey = observable();
  health.publish({ state: 'idle' });

  // A request method: never throws synchronously, rejects with code 'stopped' once stopped, parks
  // while stalled; whatever settles after stop() is ignored (the promise is already rejected).
  const request = (/** @type {(...args: any[]) => any} */ fn) => (/** @type {any[]} */ ...args) => {
    if (state === 'stopped') return Promise.reject(stoppedError());
    return new Promise((resolve, reject) => {
      const entry = {
        reject,
        run() {
          if (!pending.has(entry)) return;
          Promise.resolve().then(() => fn(...args)).then(
            (v) => { if (pending.delete(entry)) resolve(v); },
            (e) => { if (pending.delete(entry)) reject(e); },
          );
        },
      };
      pending.add(entry);
      if (stalled) held.add(entry);
      else entry.run();
    });
  };

  // Ctrl+Alt+C: the compositor script owns it while it runs (Electron never registers it first
  // then); when the script gives up, Electron's own takes over, and hands it back on its return.
  const fireStow = () => onHotkey.publish('stow');
  const ensureStow = () => { if (!shortcuts.isRegistered(STOW_ACCEL)) shortcuts.register(STOW_ACCEL, fireStow); };
  const dropStow = () => { if (shortcuts.isRegistered(STOW_ACCEL)) shortcuts.unregister(STOW_ACCEL); };

  const screenshotOrder = () => [
    ...(handle?.methods().screenshot || []),
    ...(screenshot.BASE_METHODS[caps.facts.server] || []),
  ];

  /** @param {any} self */
  const resolveWaiters = (self) => {
    if (!self) return;
    for (const w of [...waiters]) {
      if (sameRect(w.rect, self)) { waiters.delete(w); w.resolve(self); }
    }
  };

  /** @param {boolean} ok */
  const onState = (ok) => {
    if (state === 'stopped') return;
    if (adapterShortcut) { if (ok) dropStow(); else ensureStow(); }
    state = ok ? 'ready' : 'degraded';
    health.publish(ok ? { state: 'ready' } : { state: 'degraded', reason: 'the window adapter is down' });
  };

  const start = () => {
    if (state !== 'idle') return Promise.resolve(); // idempotent; stop() is final
    state = 'starting';
    handle = adapters.startAdapters({
      caps, overlay, session: caps.session, area, log, factories,
      onState,
      onCommand: (/** @type {string} */ name) => { if (name === 'toggle') fireStow(); },
      onPointer: (/** @type {any} */ p) => pointer.publish(p),
      onFrame: (/** @type {import('../../core/ports').WindowsFrame} */ frame) => {
        frames.publish(frame);
        resolveWaiters(frame.self); // the controller's confirmed place
      },
      onFact: (/** @type {import('../../core/ports').DevicesFact} */ fact) => facts.publish(fact),
    });
    if (!adapterShortcut) ensureStow();
    if (!caps.adapters().length) { state = 'ready'; health.publish({ state: 'ready' }); }
    return Promise.resolve();
  };

  const stop = () => {
    if (state === 'stopped') return Promise.resolve();
    state = 'stopped';
    health.publish({ state: 'stopped' }); // heard before the subscribers go
    for (const p of pending) p.reject(stoppedError());
    pending.clear();
    held.clear();
    waiters.clear();
    dropStow();
    for (const a of extraAccels) shortcuts.unregister(a);
    extraAccels.clear();
    handle?.stop();
    for (const o of [health, frames, pointer, facts, onHotkey]) o.clear();
    return Promise.resolve();
  };

  const shell = {
    caps: () => ({
      tier: backend === 'generic' ? 2 : 1,
      backend,
      windows: caps.has('windowTracking'),
      pointer: backend === 'kwin' && caps.has('windowTracking'),
      apps: { list: caps.has('appList'), close: caps.has('appClose') },
      hotkey: true, // the script's or Electron's fallback: one of them always owns it
      screenshot: screenshotOrder(),
      overlay: {
        place: nativeWayland ? 'compositor' : 'client',
        stacking: nativeWayland ? 'compositor' : 'client',
        focus: backend === 'kwin' ? 'compositor' : 'client',
        input,
      },
    }),
    health,
    observe: {
      frames, pointer, facts,
      workArea: request(async () => null), // null → Electron's workArea
    },
    overlay: {
      // Resolves with the confirmed place; the controller awaits it with a timeout of its own.
      request: request((/** @type {any} */ rect) => new Promise((resolve) => {
        const now = handle?.frame()?.self ?? null;
        if (sameRect(now, rect)) return resolve(now);
        waiters.add({ rect, resolve });
      })),
      raise: () => {}, // the compositor's script keeps her on top on its own
      focus: (/** @type {boolean} */ on) => handle?.focus(on),
      zones: (/** @type {any} */ z) => handle?.setZones(z.rects),
      identity: () => {}, // the adapters already know her pid and title
    },
    control: {
      hotkey: request(async (/** @type {string} */ id, /** @type {string} */ accel) => {
        const ok = shortcuts.register(accel, () => onHotkey.publish(id));
        if (ok) extraAccels.add(accel);
        return ok;
      }),
      onHotkey,
      closeApps: request(async (/** @type {string[]} */ names, /** @type {any} */ o) => {
        let running = false;
        for (const n of names || []) {
          const r = await apps.close(n, { force: Boolean(o?.force), watch: handle?.apps() || null });
          running = running || Boolean(r?.running);
        }
        return { running };
      }),
    },
    os: {
      windows: request(() => apps.list({ watch: handle?.apps() || null })),
      launchables: request(async () => {
        if (!launch) return notWired('os.launchables')();
        return launch.launchables();
      }),
      launch: request(notWired('os.launch')),
      media: request(async (/** @type {string} */ action) => {
        if (!launch) return notWired('os.media')();
        return launch.media(action);
      }),
      search: request(async (/** @type {string} */ query) => {
        if (!files) return notWired('os.search')();
        const found = await files.search({ query });
        return found.map((/** @type {any} */ r) => r.path);
      }),
      screenshot: request((/** @type {any} */ o) => screenshot.grab({
        methods: screenshotOrder(), display: o.display, multi: o.multi,
      })),
      terminal: request(notWired('os.terminal')),
    },
    /** @param {any[]} _list */
    setDisplays(_list) {}, // the legacy feed reads Electron's screen itself
    start,
    stop,
    // --- transitional accessors, no port equivalent yet (see the header) ---
    cursor: () => handle?.cursor() ?? null,
    refresh: () => handle?.refresh(),
    appWatch: () => handle?.apps() ?? null,
    inputKind: () => inputKind,
  };

  return {
    shell,
    drive: {
      frame: (/** @type {any} */ f) => frames.publish(f),
      stall: () => {
        stalled = true;
        return () => {
          stalled = false;
          for (const e of [...held]) { held.delete(e); e.run(); }
        };
      },
    },
  };
}

module.exports = { createLegacyShell, STOW_ACCEL };