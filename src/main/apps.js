'use strict';

// Closing an app when you ask her to (chat.js), after you've confirmed with a click. The apps with
// a window, by name; closing one the way its own close button does (it can still ask you to save),
// and only if you ask again, forcing it. KDE on Wayland (the windows KWin reports: linux/apps-linux.js).

// [{ name, process, ids }]: one per program with a window open. `watch`: the adapter's windows.
async function list({ watch = null } = {}) {
  return require('./linux/apps-linux').list({ watch });
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The open app that `wanted` names, by its name or its description ("am music", "YouTube Music").
async function find(wanted, { watch = null } = {}) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const apps = await list({ watch });
  const score = (app) => {
    const names = [simple(app.name), simple(app.label)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = apps.map((app) => [score(app), app]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

// Closes it like its close button would; `force` ends it outright (unsaved work is lost).
// Resolves with what's left: { running } (true when it stayed open, or hid in the tray), and
// { unsupported } where she can't close apps. Redirected to apps-linux method
async function close(name, { force = false, watch = null } = {}) {
  return require('./linux/apps-linux').close(name, { force, watch });
}

module.exports = { list, find, close};
