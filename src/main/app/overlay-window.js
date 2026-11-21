'use strict';

// The overlay window's single owner: where it is, whether it is on top, who has the keyboard, and
// where it takes the mouse. Placement and stacking are either the client's (this process sets
// them) or the compositor's (asked through the shell, confirmed back through its frames). The
// input strategy is picked from the shell's capabilities, never guessed from the environment here.
//
// A placement is confirmed, not assumed: the client reads the window back after it settles, the
// compositor's answer is awaited with a timeout — never a polling loop.

const { createToggleInput } = require('../platform/input/toggle');
const { createXShapeInput } = require('../platform/input/xshape-client');
const { createPassthroughInput } = require('../platform/input/passthrough');

const INPUT = { xshape: createXShapeInput, toggle: createToggleInput, passthrough: createPassthroughInput };
const EVENTS = ['resize', 'moved', 'show', 'maximize', 'unmaximize', 'restore'];

const sameRect = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
const toDip = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
const fromDip = (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

/**
 * @param {object} o
 *   BrowserWindow: Electron's (injected, so a fake window can stand in)
 *   shell: the DesktopShell port (or the slice of it the controller uses)
 *   clock: now/setTimeout/clearTimeout; every wait goes through it
 *   store: reserved for the state slices; until then the controller keeps its own focus flag
 *   nativeTheme: its 'updated' event resets the window's frame hints, the input is said again
 *   input: { xshape, mode } — the exact-shape factory and the resolved variant, when known
 *   areaOf(): { area, gap } — where the window should be now, and how much hangs below the work area
 *   onResize({ width, height, gap }): the renderer is told (main owns the IPC until the registry)
 *   onRearm(): after a rearm (main tells the renderer its pointer knowledge is stale)
 */
function createOverlayController({
  BrowserWindow, shell, clock, log = console, store = null, nativeTheme = null,
  input = {}, areaOf = () => ({ area: { x: 0, y: 0, width: 0, height: 0 }, gap: 0 }),
  onResize = () => {}, onRearm = () => {},
  settleMs = 60, confirmTimeoutMs = 1500, raiseRepeatMs = 400,
  defer = (fn) => setImmediate(fn),
}) {
  let win = null;
  let strategy = null;
  let managed = false;      // a compositor-managed window: titled, focusable only while her chat is open
  let focusOn = false;
  let lastRequested = null;
  let confirmedSelf = null; // where the compositor last said the window is
  let reapplyArmed = false;
  const offs = [];

  const alive = () => Boolean(win && !win.isDestroyed());
  const caps = () => shell.caps().overlay;

  // The setBounds call, deduped: the same request again is not sent (on XWayland each one is a
  // configure request the compositor answers with a new frame).
  const request = (area) => {
    if (!alive() || sameRect(lastRequested, area)) return false;
    lastRequested = { x: area.x, y: area.y, width: area.width, height: area.height };
    win.setBounds(lastRequested);
    return true;
  };

  const onFrame = (frame) => {
    const s = frame && frame.self;
    if (s && Number.isFinite(s.x)) confirmedSelf = fromDip(s);
  };

  // Ask for a place, resolve with the confirmed one. Client: the window is read back once it has
  // settled. Compositor: the shell's request resolves when the compositor confirms; a timeout
  // falls back to the last confirmed place (or the window's own answer).
  const place = async (area) => {
    if (!alive()) return confirmedSelf;
    const rect = { x: area.x, y: area.y, width: area.width, height: area.height };
    if (caps().place === 'compositor') {
      const asked = shell.overlay.request(toDip(rect));
      request(rect);
      return await new Promise((resolve) => {
        const timer = clock.setTimeout(() => resolve(confirmedSelf || (alive() ? win.getBounds() : null)), confirmTimeoutMs);
        asked.then(
          (r) => { clock.clearTimeout(timer); resolve(fromDip(r)); },
          () => { clock.clearTimeout(timer); resolve(confirmedSelf || (alive() ? win.getBounds() : null)); },
        );
      });
    }
    request(rect);
    return await new Promise((resolve) => {
      clock.setTimeout(() => resolve(alive() ? win.getBounds() : confirmedSelf), settleMs);
    });
  };

  // Fit to where the window should be now: request it, say the input again (the frame hints may
  // have been reset), tell the renderer its size.
  const fit = () => {
    if (!alive()) return;
    const { area, gap } = areaOf();
    request(area);
    strategy?.reapply();
    onResize({ width: area.width, height: area.height, gap });
  };

  // The last confirmed position: the compositor's word where it owns the place, else the window's.
  const bounds = () => {
    if (!alive()) return confirmedSelf;
    return caps().place === 'compositor' ? (confirmedSelf || win.getBounds()) : win.getBounds();
  };

  // Back on top of everything. The compositor's script keeps her there on its own; the client says
  // it twice: the taskbar can come up again a moment later, as its menus and previews open.
  const raise = () => {
    if (!alive()) return;
    if (caps().stacking === 'compositor') { shell.overlay.raise(); return; }
    for (const wait of [0, raiseRepeatMs]) {
      clock.setTimeout(() => {
        if (!alive()) return;
        win.setAlwaysOnTop(true, 'screen-saver');
        win.moveTop();
      }, wait);
    }
  };

  // After sleep or a locked screen: her place on top, her size and her input are set again, and the
  // renderer learns its pointer knowledge is stale.
  const rearm = () => {
    if (!alive()) return;
    if (process.platform !== 'linux') {
      win.setIgnoreMouseEvents(false);
      win.setIgnoreMouseEvents(true, { forward: true });
    }
    if (caps().stacking !== 'compositor') {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (caps().focus === 'compositor' && !focusOn) win.setFocusable(false);
    }
    fit();
    onRearm();
  };

  // The keyboard: hers while her chat is open, back to the window you were on after. A compositor
  // that manages her window does not hand it the keyboard on its own — the shell is told too.
  const focus = (on) => {
    if (!alive()) return;
    focusOn = Boolean(on);
    win.setFocusable(focusOn);
    shell.overlay.focus(focusOn);
    if (focusOn) win.focus();
    else win.blur();
    strategy?.reapply(); // the hints have changed — the region might have been reset
  };

  const setZones = ({ rects, dpr }) => {
    if (!alive()) return;
    const list = Array.isArray(rects) ? rects : [];
    strategy?.set(list, dpr);
    shell.overlay.zones({ rects: list, dpr });
  };

  // The window's frame hints reset the input region on every bounds, state and theme change
  // (electron#54393): say it again after those, one at a time however many come together.
  const again = () => {
    if (reapplyArmed) return;
    reapplyArmed = true;
    defer(() => {
      reapplyArmed = false;
      if (alive()) strategy?.reapply();
    });
  };

  const create = ({ preload, url, managed: isManaged = false, title = '', devtools = false, onGone = null, onConsoleMessage = null }) => {
    managed = isManaged;
    const { area } = areaOf();
    win = new BrowserWindow({
      ...area,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // A managed window is focusable, but not focused by a click: the keyboard is hers only while
      // her chat is open (focus below). An unmanaged one is never focusable.
      focusable: managed,
      ...(managed ? { title } : {}),
      hasShadow: false,
      alwaysOnTop: true,
      type: undefined,
      show: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    win.setAlwaysOnTop(true, 'screen-saver');
    if (managed) win.setFocusable(false);

    const makeInput = INPUT[caps().input] || createPassthroughInput;
    strategy = makeInput({ window: win, clock, log, xshape: input.xshape || null, mode: input.mode });
    strategy.set([], 1); // click-through before anything of hers is drawn

    for (const e of EVENTS) {
      win.on(e, again);
      offs.push(() => win.removeListener?.(e, again));
    }
    if (nativeTheme) {
      nativeTheme.on('updated', again);
      offs.push(() => nativeTheme.removeListener?.('updated', again));
    }
    offs.push(shell.observe.frames.subscribe(onFrame));
    offs.push(shell.observe.pointer.subscribe((p) => strategy?.pointer?.(p)));

    win.loadURL(url);
    // Always shown: put away, she's still there as her biochip in the corner. Sized again first:
    // a new window may be kept inside the work area, and resting on the taskbar it covers it too.
    win.once('ready-to-show', () => {
      fit();
      win.showInactive();
      strategy?.reapply(); // once mapped
      if (managed) win.setFocusable(false); // again, now that it is mapped
    });
    if (onGone) win.webContents.on('render-process-gone', (_e, details) => onGone(details));
    if (onConsoleMessage) win.webContents.on('console-message', onConsoleMessage);
    if (devtools) win.webContents.openDevTools({ mode: 'detach' });
    return win;
  };

  const close = () => {
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* intentional: teardown is best effort */ }
    }
    strategy?.close();
    strategy = null;
  };

  return {
    create,
    place,
    fit,
    bounds,
    raise,
    rearm,
    focus,
    setZones,
    close,
    window: () => win,
    inputKind: () => strategy?.kind ?? null,
    inputStats: () => strategy?.stats?.() ?? null,
    inputState: () => strategy?.state?.() ?? null,
  };
}

module.exports = { createOverlayController, INPUT };