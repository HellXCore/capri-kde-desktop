'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them. On Linux X11
// linux/x11-watch.js reads the window manager (EWMH) through xprop/xwininfo; in a KDE Wayland
// session (Capri itself in XWayland) a KWin script reports every window, native Wayland ones too
// (linux/kwin-bridge.js). Either gives physical pixels (KWin: its logical ones, the same while
// XWayland is scaled by KWin), which we turn into the overlay's coordinates.

const path = require('node:path');
const { screen, app } = require('electron');

// The snapshots of a watcher, as seen from her window, to onUpdate. `toDip(win)`: the watcher's
// physical-pixel rect -> Electron's screen DIPs ({ x, y, width, height }).
// `ai`, `game`, `usb`, `plug` are what only the Windows helper used to report; they stay in the
// shape the overlay expects (empty on Linux, except `ai` from the KWin script).
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

// `session` from capabilities.linuxSession(); never just because it is Linux: an X11 session is
// read through the window manager; a KDE Wayland session through a KWin script. Other Wayland
// desktops stay off (startX11Watch says so): they have nothing that lists every window.
function startLinuxWatch({ overlay, onUpdate, onState, session }) {
  // required by its full path, so the module loads the same however this file was loaded
  const { startX11Watch } = require(path.join(__dirname, 'linux', 'x11-watch.js'));
  const x11 = require(path.join(__dirname, 'linux', 'x11.js'));
  const feed = createFeed({ overlay, onUpdate, toDip: (win) => x11.pxToDip(win, screen.getAllDisplays()) });

  if (session !== 'x11' && /KDE/i.test(process.env.XDG_CURRENT_DESKTOP || '')) {
    const { startKWinWatch } = require(path.join(__dirname, 'linux', 'kwin-bridge.js'));
    // KWin leaves the overlay out of its list by pid and title, so the title is fixed
    const TITLE = 'capri-overlay';
    overlay.setTitle(TITLE);
    overlay.on('page-title-updated', (event) => event.preventDefault());
    const watch = startKWinWatch({
      session,
      scriptDir: path.join(app.getPath('userData'), 'kwin'),
      getSelf: () => ({ pid: process.pid, title: TITLE }),
      onSnapshot: feed.push,
      onState,
    });
    return { stop: watch.stop, refresh: feed.send };
  }

  const watch = startX11Watch({
    session,
    self: { id: x11.selfXid(overlay.getNativeWindowHandle()) },
    onSnapshot: feed.push,
    onState,
  });
  return { stop: watch.stop, refresh: feed.send };
}

// onState(ok): the watcher runs (true), or gave up after its restarts (false): capabilities.js
// session: 'x11' | 'xwayland' | 'wayland' | null, from capabilities.js
function startWindowWatch({ overlay, onUpdate, onState = () => {}, session = null }) {
  if (process.platform !== 'linux') return { stop() {}, refresh() {} };
  return startLinuxWatch({ overlay, onUpdate, onState, session });
}

module.exports = { startWindowWatch, createFeed };