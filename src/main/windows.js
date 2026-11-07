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
// `ai`, `game`, `usb`, `plug` are used to report; they stay in the shape the overlay expects
// (empty on Linux, except `ai` from the KWin script).
// `origin(snapshot)`: where her window is, in the same DIPs; Electron's own answer unless this says
// otherwise (native Wayland: a client does not know where its window is, KWin does).
function createFeed({ overlay, onUpdate, toDip, origin = null }) {
  let last = null; // the watcher's last snapshot: it only speaks when something changes

  const toOverlay = (win, bounds) => {
    const dip = toDip(win);
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  // the snapshot as seen from her window, wherever it is now
  const send = () => {
    if (!last || overlay.isDestroyed()) return;
    const bounds = (origin && origin(last)) || overlay.getBounds();
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
    // where her window is, if `origin` knows; else null (Electron's own answer applies)
    origin: () => (origin && last ? origin(last) : null),
  };
}

// `session` from capabilities.linuxSession(); never just because it is Linux: an X11 session is
// read through the window manager; a KDE Wayland session through a KWin script. Other Wayland
// desktops stay off (startX11Watch says so): they have nothing that lists every window.
function startLinuxWatch({ overlay, onUpdate, onState, onCommand, onPointer, area, session }) {
  // required by its full path, so the module loads the same however this file was loaded
  const { startX11Watch } = require(path.join(__dirname, 'linux', 'x11-watch.js'));
  const x11 = require(path.join(__dirname, 'linux', 'x11.js'));
  // Native Wayland: KWin's logical pixels already are Electron's DIPs (no X screen to scale), and the
  // overlay's place is KWin's to say. X11 and XWayland: the X screen's pixels, scaled to DIPs.
  const native = session === 'wayland';
  const asDip = (win) => (native ? { x: win.x, y: win.y, width: win.w, height: win.h } : x11.pxToDip(win, screen.getAllDisplays()));
  const feed = createFeed({
    overlay, onUpdate, toDip: asDip,
    origin: native ? (snap) => (snap.self ? { x: snap.self.x, y: snap.self.y, width: snap.self.w, height: snap.self.h } : null) : null,
  });

  if (session !== 'x11' && /KDE/i.test(process.env.XDG_CURRENT_DESKTOP || '')) {
    const { startKWinWatch } = require(path.join(__dirname, 'linux', 'kwin-bridge.js'));
    // KWin leaves the overlay out of its list by pid and title, so the title is fixed
    const TITLE = 'capri-overlay';
    overlay.setTitle(TITLE);
    overlay.on('page-title-updated', (event) => event.preventDefault());
    const watch = startKWinWatch({
      session,
      scriptDir: path.join(app.getPath('userData'), 'kwin'),
      getSelf: () => {
        // Native Wayland: where she should be, from the caller (a client cannot place its window,
        // so the KWin script does), in KWin's pixels, which are DIPs.
        if (native && area) {
          const a = area();
          if (a) return { pid: process.pid, title: TITLE, rect: { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) } };
        }
        // where her window is, in the X screen's pixels (what KWin sees): its DIPs times the scale
        const b = overlay.getBounds();
        const k = (screen.getDisplayMatching(b) || {}).scaleFactor || 1;
        return { pid: process.pid, title: TITLE, rect: { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.width * k), h: Math.round(b.height * k) } };
      },
      onSnapshot: feed.push,
      onState,
      onCommand,
      onPointer,
    });
    return {
      stop: watch.stop,
      refresh: feed.send,
      source: 'kwin', // the same script also lists and closes apps, and owns Ctrl+Alt+C
      focus: (on) => watch.focus(on), // the keyboard, for typing to her (her chat)
      origin: feed.origin, // native Wayland: where KWin has her window ({ x, y, width, height }), else null
      // where the pointer really is, in the screen's DIPs ({ x, y }), or null until KWin has said:
      // under XWayland Electron's own cursor point is stale over native Wayland windows
      cursor: () => {
        const at = watch.cursor();
        if (!at) return null;
        const dip = asDip({ x: at.x, y: at.y, w: 0, h: 0 });
        return { x: dip.x, y: dip.y };
      },
    };
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
// onPointer({ x, y }): where the pointer is from the overlay's top left corner (native Wayland's input
// region follows it); area(): where the overlay should be ({ x, y, width, height } in DIPs).
function startWindowWatch({ overlay, onUpdate, onState = () => {}, onCommand = () => {}, onPointer = () => {}, area = null, session = null }) {
  if (process.platform !== 'linux') return { stop() {}, refresh() {} };
  return startLinuxWatch({ overlay, onUpdate, onState, onCommand, onPointer, area, session });
}

module.exports = { startWindowWatch, createFeed };