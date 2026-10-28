'use strict';

// macOS window watch (prototype, CAPRI-08): the same contract as startWindowWatch() in
// ../windows.js, fed by the small Swift helper next to this file (capri-windows.swift). Not wired
// into main.js yet: that is CAPRI-09.
//
// The helper speaks in global points with the origin at the main display's top-left corner and y
// going down. Electron's screen coordinates on macOS are the same points (DIP), so unlike the
// Windows helper's physical pixels nothing has to be scaled: only shifted into the overlay's frame.
// Of the Windows fields only `fg` and `wins` exist here; the others keep their empty defaults.

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn: nodeSpawn } = require('node:child_process');

// in the installed app it would sit next to the app archive (asarUnpack); packaging is CAPRI-09
const HELPER = path.join(__dirname, 'bin', 'capri-windows').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const MAX_WINDOWS = 40;
const LIMIT = 1e6; // no real screen is this far away: anything beyond is garbage

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < LIMIT;
const windowId = (n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff;

// One line of the helper into a snapshot, or null if it is not one. Unknown fields are dropped,
// so nothing the helper might add later (or a title, should it ever print one) travels further.
function parseLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.wins)) return null;
  const wins = [];
  for (const w of raw.wins) {
    if (wins.length >= MAX_WINDOWS) break;
    if (!w || !windowId(w.id) || ![w.x, w.y, w.w, w.h].every(finite) || w.w <= 0 || w.h <= 0) continue;
    wins.push({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, max: w.max === true, full: w.full === true });
  }
  const displays = (Array.isArray(raw.displays) ? raw.displays : [])
    .filter((d) => d && windowId(d.id) && [d.x, d.y, d.w, d.h].every(finite) && d.w > 0 && d.h > 0)
    .map((d) => ({ id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, scale: finite(d.scale) && d.scale > 0 ? d.scale : 1 }));
  return { fg: windowId(raw.fg) ? raw.fg : null, wins, displays };
}

// The snapshot as seen from her window (`bounds`, in screen DIP), in the Windows watcher's shape.
function toUpdate(snapshot, bounds) {
  const wins = snapshot.wins
    .map((w) => ({ id: w.id, x: w.x - bounds.x, y: w.y - bounds.y, w: w.w, h: w.h, max: w.max, full: w.full }))
    // only what overlaps Capri's screen
    .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
  return { fg: snapshot.fg, taskbar: false, ai: [], game: null, usb: [], plug: null, wins };
}

// Capri's own overlay, as a window number the helper can skip ("window:<CGWindowID>:0")
function overlayWindowId(overlay) {
  try {
    const m = /^window:(\d+):/.exec(overlay.getMediaSourceId());
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function startMacWindowWatch({ overlay, onUpdate, helper = HELPER, spawn = nodeSpawn, log = console.error, excludeOwnProcess = false }) {
  const idle = { available: false, stop() {}, refresh() {} };
  if (!fs.existsSync(helper)) {
    log('[capri] window watch: macOS helper not built, windows are not tracked');
    return idle; // she keeps the screen floor and the corners: the base overlay
  }

  let child = null;
  let stopped = false;
  let restarts = 0;
  let last = null; // the helper's last snapshot: it only speaks when something changes

  const send = () => {
    if (!last || overlay.isDestroyed()) return;
    onUpdate(toUpdate(last, overlay.getBounds()));
  };

  const start = () => {
    const startedAt = Date.now();
    const args = ['--parent', String(process.pid), '--watch-stdin'];
    const self = overlayWindowId(overlay);
    if (self) args.push('--self-window', String(self));
    // her other windows (chat, setup) are fair perches on Windows too; skipping them is optional
    if (excludeOwnProcess) args.push('--exclude-pid', String(process.pid));
    child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const snap = parseLine(line);
      if (!snap) return;
      last = snap;
      send();
    });
    child.stderr.on('data', (d) => log('[capri] window watch:', String(d).trim()));
    child.on('error', (err) => log('[capri] window watch:', err.message));
    child.on('exit', () => {
      child = null;
      // a helper that ran a good while earns its restarts back; one that keeps dying stops after 3
      if (Date.now() - startedAt > 60000) restarts = 0;
      if (!stopped && restarts++ < 3) setTimeout(start, 3000);
    });
  };

  start();
  return {
    available: true,
    stop() {
      stopped = true;
      child?.kill();
    },
    // her window moved (another screen): the same windows, from there
    refresh: send,
  };
}

module.exports = { startMacWindowWatch, parseLine, toUpdate, overlayWindowId, HELPER };
