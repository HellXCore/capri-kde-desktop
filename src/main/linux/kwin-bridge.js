'use strict';

// Window tracking for KDE Plasma 6 on Wayland, the Electron half (src/main/kwin-bridge.js).
//
// x11-watch.js stays off in a Wayland session: the X server only sees XWayland windows. KWin sees
// them all, so a small KWin script (kwin-windows.qml) runs inside it and pushes what it knows
// over D-Bus to the service started here. What arrives is already in the shapes x11.js parses
// xprop/xwininfo output into, so x11.buildSnapshot() does the rest and windows.js gets the same
// snapshot as from startX11Watch.
//
//   KWin script --Update(json)--> org.capri.WindowBridge (here) --> x11.buildSnapshot --> onSnapshot
//                 <--reply: { selfPid, selfTitle } (so the script leaves the overlay out)
//
// No npm dependency: the D-Bus side is dbus-mini.js. The script is written to scriptDir (a real
// path: KWin cannot read inside an asar) and loaded/unloaded through org.kde.KWin /Scripting;
// nothing is installed into the user's KWin scripts. Only KWin's own connection may call Update.

const fs = require('node:fs');
const path = require('node:path');
const x11 = require('./x11');
const { Bus } = require('./dbus-mini');

const BUS_NAME = 'org.capri.WindowBridge';
const OBJECT_PATH = '/org/capri/WindowBridge';
const SCRIPT_NAME = 'capri-windows';
const FIRST_UPDATE_MS = 6000; // the script says nothing in this time: give up (onState(false))

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const list = (v) => (Array.isArray(v) ? v : []);

// KWin's logical pixels -> the X screen's pixels. 'logical' (default): the same thing, which is
// right while XWayland is scaled by KWin (Plasma's default, "Legacy applications: scaled by the
// system"). 'physical': the user let XWayland apps scale themselves, so X pixels are real ones;
// each rectangle is multiplied by the scale of the output holding its centre.
function toXPixels(rect, outputs, units) {
  if (units !== 'physical') return rect;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const out = list(outputs).find((o) => cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h);
  const s = (out && out.s) || 1;
  return { x: Math.round(rect.x * s), y: Math.round(rect.y * s), w: Math.round(rect.w * s), h: Math.round(rect.h * s) };
}

// What the KWin script sent -> the snapshot in the Windows helper's format. The message comes off
// the session bus, so its shape is checked rather than trusted.
function fromPayload(payload, { units = 'logical' } = {}) {
  if (!payload || typeof payload !== 'object' || payload.v !== 1) throw new Error('unknown payload');
  const r = payload.root || {};
  const root = {
    active: isNum(r.active) ? r.active : null,
    stacking: list(r.stacking).filter(isNum), // front first, as x11.parseRoot gives it
    desktop: isNum(r.desktop) ? r.desktop : null,
  };

  const infos = new Map();
  for (const [key, v] of Object.entries(payload.infos || {})) {
    const id = Number(key);
    if (!isNum(id) || !v || typeof v !== 'object') continue;
    infos.set(id, {
      types: list(v.types).filter((t) => typeof t === 'string'),
      state: list(v.state).filter((t) => typeof t === 'string'),
      desktop: isNum(v.desktop) ? v.desktop : null,
      frame: null,
      csd: null,
      pid: isNum(v.pid) ? v.pid : null,
    });
  }

  const rects = new Map();
  for (const [key, v] of Object.entries(payload.rects || {})) {
    const id = Number(key);
    if (!isNum(id) || !v || ![v.x, v.y, v.w, v.h].every(isNum)) continue;
    rects.set(id, toXPixels({ x: v.x, y: v.y, w: v.w, h: v.h }, payload.outputs, units));
  }

  const snap = x11.buildSnapshot({ root, infos, rects, self: {} });
  // what only the KWin side knows: the AIs the window in front is (keys only, no titles)
  snap.ai = list(payload.ai).filter((k) => typeof k === 'string').slice(0, 8);
  // `game`, `usb`, `plug` stay as buildSnapshot leaves them (Windows reports those)
  return snap;
}

// session: capabilities.linuxSession(). getSelf(): { pid, title } of the overlay (its pid and the
// window title it was given), to leave it out. scriptDir: a writable real directory.
// Same contract as startX11Watch: onSnapshot(snap) physical-pixel snapshots, onState(ok).
function startKWinWatch({
  session, getSelf = () => ({}), scriptDir, onSnapshot, onState = () => {},
  units = process.env.CAPRI_KWIN_UNITS === 'physical' ? 'physical' : 'logical',
  log = console,
}) {
  const noop = { stop() {} };
  const kde = /KDE/i.test(process.env.XDG_CURRENT_DESKTOP || '');
  // 'xwayland': Capri itself runs through XWayland inside the Wayland session; 'wayland': natively
  if (!['wayland', 'xwayland'].includes(session) || !kde) {
    log.log(`[capri] kwin watch: off (needs a KDE Wayland session, this is ${kde ? 'KDE' : 'not KDE'} / ${session || 'no session'})`);
    onState(false);
    return noop;
  }

  let stopped = false;
  let bus = null;
  let running = false; // has an update arrived (and onState(true))
  let lastJson = '';
  let firstTimer = null;

  const fail = (why) => {
    if (stopped) return;
    log.error(`[capri] kwin watch: ${why}`);
    onState(false);
  };

  const update = (text) => {
    try {
      const snap = fromPayload(JSON.parse(text), { units });
      if (!running) {
        running = true;
        clearTimeout(firstTimer);
        log.log('[capri] kwin watch: ready');
        onState(true);
      }
      const json = JSON.stringify(snap);
      if (json !== lastJson) {
        lastJson = json;
        onSnapshot(snap);
      }
    } catch (err) {
      log.error('[capri] kwin watch: bad update:', err?.message ?? err);
    }
    const self = getSelf() || {};
    return JSON.stringify({ selfPid: self.pid || 0, selfTitle: self.title || '' });
  };

  const KWIN = { destination: 'org.kde.KWin', path: '/Scripting', iface: 'org.kde.kwin.Scripting' };

  const start = async () => {
    bus = await Bus.connect();
    bus.onClose = (err) => {
      if (!stopped) fail(`lost the session bus (${err?.message ?? err})`);
    };

    // The script runs inside KWin and calls through KWin's own bus connection, so the caller
    // must be the owner of org.kde.KWin. Anything else on the bus is refused.
    let kwinOwner = await bus.getNameOwner('org.kde.KWin');
    // CAPRI_KWIN_ANY_SENDER=1 switches the check off (if a KWin build calls from another connection)
    const anySender = process.env.CAPRI_KWIN_ANY_SENDER === '1';
    let refused = false;
    const fromKWin = async (sender) => {
      if (anySender || sender === kwinOwner) return true;
      try {
        kwinOwner = await bus.getNameOwner('org.kde.KWin');
      } catch {
        // KWin is gone
      }
      if (sender === kwinOwner) return true;
      if (!refused) {
        refused = true; // said once
        log.error(`[capri] kwin watch: refused an Update from ${sender}, org.kde.KWin is ${kwinOwner} (CAPRI_KWIN_ANY_SENDER=1 lifts the check)`);
      }
      return false;
    };

    bus.export(OBJECT_PATH, BUS_NAME, {
      Update: {
        in: 's',
        out: 's',
        fn: async ([text], { sender }) => {
          if (!(await fromKWin(sender))) {
            throw Object.assign(new Error('only KWin may call this'), { dbusName: 'org.freedesktop.DBus.Error.AccessDenied' });
          }
          return [update(text)];
        },
      },
    });
    const owned = await bus.requestName(BUS_NAME, 4); // 4: DO_NOT_QUEUE
    if (owned !== 1) throw new Error(`${BUS_NAME} is taken (another Capri running?)`);

    // the script, written out where KWin can read it, and started
    fs.mkdirSync(scriptDir, { recursive: true });
    const file = path.join(scriptDir, `${SCRIPT_NAME}.qml`);
    fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, 'kwin-windows.qml')));

    const [loaded] = await bus.call({ ...KWIN, member: 'isScriptLoaded', args: [['s', SCRIPT_NAME]] });
    if (loaded) await bus.call({ ...KWIN, member: 'unloadScript', args: [['s', SCRIPT_NAME]] }); // a leftover
    const [id] = await bus.call({ ...KWIN, member: 'loadDeclarativeScript', args: [['s', file], ['s', SCRIPT_NAME]] });
    if (id < 0) throw new Error('KWin did not load the script');
    await bus.call({ destination: 'org.kde.KWin', path: `/Scripting/Script${id}`, iface: 'org.kde.kwin.Script', member: 'run' });

    if (stopped) return;
    firstTimer = setTimeout(() => {
      if (!running) fail('the KWin script sent nothing (see: journalctl --user -b | grep -i capri-windows)');
    }, FIRST_UPDATE_MS);
  };

  start().catch((err) => fail(err?.message ?? String(err)));

  return {
    stop() {
      stopped = true;
      clearTimeout(firstTimer);
      if (!bus) return;
      bus.call({ ...KWIN, member: 'unloadScript', args: [['s', SCRIPT_NAME]] }).catch(() => {}).finally(() => bus.close());
    },
  };
}

module.exports = { startKWinWatch, fromPayload, toXPixels, BUS_NAME, OBJECT_PATH, SCRIPT_NAME };
