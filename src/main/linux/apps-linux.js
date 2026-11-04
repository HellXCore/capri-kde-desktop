'use strict';

// The open apps and closing one, on Linux (apps.js). The windows KWin reports (kwin-bridge.js), one
// app per program, by its desktop file or window class. Closing asks KWin to close its windows the
// way the close button does (the app can still ask you to save); forcing it ends its processes.

const kwin = require('./kwin-bridge');
const entries = require('./desktop-entries');

// never these: the desktop itself, KDE's own pieces, her (Capri), Claude (she watches it) and
// Ollama (she talks through it)
const KEEP = new Set([
  'org.kde.plasmashell', 'plasmashell', 'kwin_wayland', 'kwin_x11', 'org.kde.krunner', 'krunner',
  'org.kde.kscreenlocker_greet', 'org.kde.polkit-kde-authentication-agent-1', 'xwaylandvideobridge',
  'org.kde.kded6', 'org.kde.ksmserver', 'capri', 'electron', 'claude', 'codex', 'ollama', 'ollama app',
]);
const SEATS = new Set(['NORMAL', 'DIALOG']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // there, and not ours to signal
  }
};

// [{ name, process, label, ids }]: one per program with a window open. `name` is what close() is
// given back: its desktop file ("org.mozilla.firefox"), else its window class.
async function list({ watch = kwin.current(), desktop = entries } = {}) {
  if (!watch) return [];
  const apps = new Map();
  for (const w of watch.windows()) {
    if (!w.pid || w.pid === process.pid) continue;
    if (!SEATS.has(w.types[0] || 'NORMAL') || w.state.includes('SKIP_TASKBAR')) continue;
    const name = w.app || w.cls;
    if (!name || KEEP.has(name.toLowerCase()) || KEEP.has(w.cls.toLowerCase())) continue;
    let app = apps.get(name);
    if (!app) {
      const entry = desktop.forWindow({ app: w.app, cls: w.cls });
      app = { name, process: name, label: entry?.name || w.cls || name, ids: [] };
      apps.set(name, app);
    }
    if (!app.ids.includes(w.pid)) app.ids.push(w.pid);
  }
  return [...apps.values()];
}

// Closes it like its close button would; `force` ends its processes outright (unsaved work is
// lost). Resolves with what is left: { running } (true when it stayed open, or hid in the tray).
async function close(name, { force = false, watch = kwin.current(), wait = sleep } = {}) {
  const app = (await list({ watch })).find((a) => a.process === name);
  if (!app) return { running: false };
  const pids = app.ids.filter((pid) => pid > 1 && pid !== process.pid);
  if (force) {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone already, or not ours
      }
    }
    await wait(600);
  } else {
    watch.closeApps(pids);
    await wait(2500); // KWin picks the command up on its next poll, and the app may ask to save
  }
  return { running: pids.some(alive) };
}

module.exports = { list, close, KEEP };
