'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them. An adapter
// (adapters.js) hands over its snapshots in its own units; here they become the overlay's coordinates.
// Which adapter runs, and what it can do, is none of this file's business.

const x11 = require('./linux/x11');

// One rectangle of a snapshot, in Electron's screen DIPs. 'dip': the adapter already speaks them
// (a native Wayland compositor's logical pixels). 'x-physical': the X screen's pixels, which
// Chromium scales by each display's factor.
function toDip(win, units) {
  if (units === 'dip') return { x: win.x, y: win.y, width: win.w, height: win.h };
  return x11.pxToDip(win, require('electron').screen.getAllDisplays());
}

// The snapshots of a watcher, as seen from her window, to onUpdate. `toDip(win)`: the watcher's
// rect -> Electron's screen DIPs ({ x, y, width, height }). `ai`, `game`, `usb`, `plug` are used to report
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

module.exports = { createFeed, toDip };