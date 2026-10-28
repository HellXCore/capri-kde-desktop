'use strict';

// Linux X11 window tracking, the running half: polls the window manager through `xprop` and
// `xwininfo` (Debian/Ubuntu: x11-utils; Fedora: xprop, xwininfo; Arch: xorg-xprop, xorg-xwininfo)
// and hands windows.js a snapshot in the Windows helper's format whenever something changes.
//
// It only starts in a real X11 session. Under XWayland the X server sees XWayland clients only:
// native Wayland windows (most of a GNOME/KDE Wayland desktop) would be missing and the window in
// front would be wrong, so it stays off there rather than half-work. Missing tools, no EWMH window
// manager, or repeated failures: onState(false), and she keeps her basic overlay.

const { execFile } = require('node:child_process');
const x11 = require('./x11');

const INTERVAL = 500;     // ms between polls
const FULL_EVERY = 4000;  // ms: every window's properties read again (state changes without a move)
const GIVE_UP = 5;        // failed polls in a row before giving up

function execTool(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

// session: capabilities.linuxSession(). self: { id } of the overlay. onSnapshot(snap) gets
// physical-pixel snapshots; onState(ok) whether tracking runs. run/timer are for the tests.
function startX11Watch({
  session, self = {}, onSnapshot, onState = () => {}, run = execTool,
  timer = { set: setTimeout, clear: clearTimeout }, log = console,
}) {
  const noop = { stop() {} };
  if (session !== 'x11') {
    log.log(`[capri] window watch: off in a ${session || 'non-graphical'} session (X11 only)`);
    onState(false);
    return noop;
  }

  let stopped = false;
  let handle = null;
  let failures = 0;
  let running = false; // has a snapshot gone out (and onState(true))
  let lastJson = '';
  let lastActive = null;
  let lastDesktop = null;
  let lastFull = 0;
  const cache = new Map(); // id -> { info, key (geometry when read), at }

  const giveUp = (why) => {
    if (stopped) return;
    stopped = true;
    log.error(`[capri] window watch: ${why}`);
    onState(false);
  };

  const props = async (id) => {
    try {
      return x11.parseWindow(await run('xprop', ['-id', `0x${id.toString(16)}`, ...x11.WINDOW_PROPS]));
    } catch {
      return null; // gone meanwhile (BadWindow): left out of this snapshot
    }
  };

  const poll = async () => {
    const [rootOut, treeOut] = await Promise.all([
      run('xprop', ['-root', ...x11.ROOT_PROPS]),
      run('xwininfo', ['-root', '-tree']),
    ]);
    const root = x11.parseRoot(rootOut);
    if (!root) throw Object.assign(new Error('no EWMH window manager (_NET_CLIENT_LIST_STACKING missing)'), { ewmh: false });
    const rects = x11.parseTree(treeOut);
    const now = Date.now();
    const full = now - lastFull >= FULL_EVERY || root.desktop !== lastDesktop;
    if (full) lastFull = now;

    // read again: new windows, moved or resized ones, the one in front and the one that was
    const ids = root.stacking.slice(0, 80);
    const stale = ids.filter((id) => {
      const c = cache.get(id);
      const r = rects.get(id);
      const key = r ? `${r.x},${r.y},${r.w},${r.h}` : '';
      return full || !c || c.key !== key || id === root.active || id === lastActive;
    });
    const fresh = await Promise.all(stale.map(props));
    stale.forEach((id, i) => {
      const r = rects.get(id);
      if (fresh[i]) cache.set(id, { info: fresh[i], key: r ? `${r.x},${r.y},${r.w},${r.h}` : '' });
    });
    for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id);
    lastActive = root.active;
    lastDesktop = root.desktop;

    // the window in front may be one outside the client list (a panel)
    const infos = new Map([...cache].map(([id, c]) => [id, c.info]));
    if (root.active && !infos.has(root.active)) {
      const info = await props(root.active);
      if (info) infos.set(root.active, info);
    }
    return x11.buildSnapshot({ root, infos, rects, self });
  };

  const tick = async () => {
    handle = null;
    if (stopped) return;
    try {
      const snap = await poll();
      if (stopped) return;
      failures = 0;
      if (!running) {
        running = true;
        log.log('[capri] window watch: x11 ready');
        onState(true);
      }
      const json = JSON.stringify(snap);
      if (json !== lastJson) {
        lastJson = json;
        onSnapshot(snap);
      }
    } catch (err) {
      if (stopped) return;
      if (err && err.code === 'ENOENT') return giveUp(`${err.path || 'xprop/xwininfo'} not found: install x11-utils (xprop, xwininfo)`);
      if (++failures >= GIVE_UP) return giveUp(err?.message || String(err));
    }
    if (!stopped) handle = timer.set(tick, INTERVAL);
  };

  tick();
  return {
    stop() {
      stopped = true;
      if (handle) timer.clear(handle);
    },
  };
}

module.exports = { startX11Watch, INTERVAL, GIVE_UP };
