'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them. On Windows a
// small PowerShell helper does the Win32 calls; on Linux X11 linux/x11-watch.js reads the window
// manager (EWMH) through xprop/xwininfo. Either gives physical pixels, which we turn into the
// overlay's coordinates. On macOS mac/window-watch.js runs a small Swift helper whose points already
// are Electron's screen coordinates. The Windows helper also says when the window in front is another AI (ChatGPT,
// Gemini…: `ai`, the names it matched), for her jealousy, and never passes on a title; which game
// is in front, if one (`game`, its folder in Steam's library or another launcher's); and the USB
// sticks plugged in (`usb`, drive letters), and the last device plugged in or out (`plug`).

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { screen } = require('electron');

// in the installed app it sits next to the app archive (asarUnpack), where PowerShell can read it
const SCRIPT = path.join(__dirname, 'windows.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// The snapshots of a watcher, as seen from her window, to onUpdate. `toDip(win)`: the watcher's
// physical-pixel rect -> Electron's screen DIPs ({ x, y, width, height }).
function createFeed({ overlay, onUpdate, toDip }) {
  let last = null; // the watcher's last snapshot: it only speaks when something changes

  const toOverlay = (win, bounds) => {
    const dip = toDip(win);
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  // the snapshot as seen from her window, wherever it is now
  const send = () => {
    if (!last || overlay.isDestroyed()) return;
    const bounds = overlay.getBounds();
    const wins = last.wins
      .map((w) => toOverlay(w, bounds))
      // only what overlaps Capri's screen
      .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
    onUpdate({
      fg: last.fg, taskbar: Boolean(last.taskbar), ai: Array.isArray(last.ai) ? last.ai : [],
      game: last.game || null, usb: Array.isArray(last.usb) ? last.usb : [], plug: last.plug || null, wins,
    });
  };

  return {
    push(snapshot) {
      last = snapshot;
      send();
    },
    send,
  };
}

// Linux: X11 only (`session` from capabilities.linuxSession(); never just because it is Linux).
function startLinuxWatch({ overlay, onUpdate, onState, session }) {
  // required by its full path, so the module loads the same however this file was loaded
  const { startX11Watch } = require(path.join(__dirname, 'linux', 'x11-watch.js'));
  const x11 = require(path.join(__dirname, 'linux', 'x11.js'));
  const feed = createFeed({ overlay, onUpdate, toDip: (win) => x11.pxToDip(win, screen.getAllDisplays()) });
  const watch = startX11Watch({
    session,
    self: { id: x11.selfXid(overlay.getNativeWindowHandle()) },
    onSnapshot: feed.push,
    onState,
  });
  return { stop: watch.stop, refresh: feed.send };
}

// macOS: the Swift helper (mac/window-watch.js), paused while the Mac sleeps or its screen is locked
// (its snapshots are not to be trusted then), and started afresh when it wakes, is unlocked or its
// screens change: also how a helper that gave up gets another chance, on a system event only.
// `power`/`screens`: Electron's powerMonitor and screen (event emitters), `later`: for the tests.
const SETTLE = { resume: 1500, 'unlock-screen': 1000, screens: 1000 }; // ms before a fresh helper

function startMacWatch({
  overlay, onUpdate, onState, power, screens, later = { set: setTimeout, clear: clearTimeout },
  start = require(path.join(__dirname, 'mac', 'window-watch.js')).startMacWindowWatch,
}) {
  let state = null;
  const watch = start({
    overlay, onUpdate,
    onState: (ok) => {
      if (ok !== state) console.log(`[capri] window tracking: ${ok ? 'on' : 'off'} (macOS helper)`);
      state = ok;
      onState(ok);
    },
  });
  if (!watch.available) return { stop() {}, refresh() {} };

  let pending = null;
  const soon = (ms) => {
    later.clear(pending);
    pending = later.set(() => {
      pending = null;
      watch.resume();
    }, ms);
  };
  const pause = () => {
    later.clear(pending);
    pending = null;
    watch.pause();
  };
  const on = {
    power: { suspend: pause, 'lock-screen': pause, resume: () => soon(SETTLE.resume), 'unlock-screen': () => soon(SETTLE['unlock-screen']) },
    // a screen plugged in, unplugged or changed: the helper's view of the screens (visible areas,
    // scale) is read again by a fresh one
    screens: Object.fromEntries(['display-added', 'display-removed', 'display-metrics-changed'].map((e) => [e, () => soon(SETTLE.screens)])),
  };
  for (const [event, fn] of Object.entries(on.power)) power?.on(event, fn);
  for (const [event, fn] of Object.entries(on.screens)) screens?.on(event, fn);

  return {
    stop() {
      later.clear(pending);
      pending = null;
      for (const [event, fn] of Object.entries(on.power)) power?.removeListener(event, fn);
      for (const [event, fn] of Object.entries(on.screens)) screens?.removeListener(event, fn);
      watch.stop();
    },
    refresh: watch.refresh,
  };
}

// onState(ok): the watcher runs (true), or gave up after its restarts (false): capabilities.js
// session (Linux): 'x11' | 'xwayland' | 'wayland' | null, from capabilities.js
function startWindowWatch({ overlay, onUpdate, onState = () => {}, session = null }) {
  if (process.platform === 'linux') return startLinuxWatch({ overlay, onUpdate, onState, session });
  if (process.platform === 'darwin') {
    const { powerMonitor } = require('electron');
    return startMacWatch({ overlay, onUpdate, onState, power: powerMonitor, screens: screen });
  }
  if (process.platform !== 'win32') return { stop() {}, refresh() {} };

  let child = null;
  let stopped = false;
  let restarts = 0;
  let retry = null; // the pending restart, cancelled by stop()

  const handle = overlay.getNativeWindowHandle();
  const self = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));

  const feed = createFeed({
    overlay, onUpdate,
    toDip: (win) => screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h }),
  });

  const start = () => {
    retry = null;
    if (stopped) return;
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, String(self), String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let snapshot;
      try {
        snapshot = JSON.parse(line);
      } catch {
        return;
      }
      onState(true);
      feed.push(snapshot);
    });
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('error', (err) => console.error('[capri] window watch:', err.message)); // no PowerShell: 'close' follows
    child.on('close', () => {
      child = null;
      if (stopped) return;
      if (restarts++ < 3) retry = setTimeout(start, 3000);
      else onState(false);
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      retry = null;
      child?.kill();
    },
    // her window moved (another screen, the taskbar in it or not): the same windows, from there
    refresh: feed.send,
  };
}

module.exports = { startWindowWatch, startMacWatch, createFeed, SCRIPT };
