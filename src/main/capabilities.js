'use strict';

// What Capri can really do on this computer, in one place: the menu, her guide, her setup and her
// chat ask this instead of guessing from the OS name. The base is what is implemented here (and
// whether its helper is in place); a native adapter that starts or fails later (window tracking on
// X11, XWayland or Wayland, CAPRI-08/09/10) reports it with set(), and whoever listens hears of the change.

const fs = require('node:fs');

// Every feature that depends on the system. Anything not here (the overlay, hooks, chat, reminders,
// opening folders, files and websites) works everywhere.
const FEATURES = [
  'windowTracking', // other windows' geometry and the one in front (sitting on them, possession, demo)
  'appList',        // the apps with a window open, by name
  'appClose',       // closing one of them
  'appLaunch',      // installed apps and games (Start menu, Steam, Epic)
  'mediaKeys',      // play/pause, next, volume, as media keys
  'autostart',      // starting with the system
  'ollamaInstall',  // installing Ollama herself (winget)
  'ollamaLaunch',   // Claude Code or Codex through Ollama, in a terminal window of its own
];

// What Electron itself runs on here: 'x11' (a real X11 session, or XWayland), 'wayland' (native),
// or null when the flag was not given ("auto" or nothing). There is no all that asks Electron.
// So this reads the --ozone-platform flag it was started with. Neither is the display server  
// the desktop runs: a Wayland desktop with Electron on x11 is XWayland.
function ozonePlatform(app) {
  try {
    const asked = app?.commandLine?.getSwitchValue?.('ozone-platform');
    if (asked === 'x11' || asked === 'wayland') return asked;
  } catch {
    // no such thing yet: not known
  }
  return null;
}

// The session on Linux: 'x11' (Electron on a real X11 desktop), 'xwayland' (Electron on x11 in 
// a Wayland desktop, partial functionality), 'wayland' (Electron native), or null (no display).
// Native Wayland windows are out of reach of X11 calls, so the use of an external adapter.
// Electron does by itself, which is native Wayland in a Wayland desktop from version 38 on
// (its --ozone-platform default is "auto"), x11 before.
function linuxSession(env = {}, ozone = null, electronMajor = Number(String(process.versions.electron || '').split('.')[0]) || 0) {
  const waylandDesktop = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  // an X11 desktop (Electron asked for wayland there falls back to x11 by itself)
  if (!waylandDesktop) return env.DISPLAY || env.XDG_SESSION_TYPE === 'x11' ? 'x11' : null;
  // a Wayland desktop: Electron is native on it, or an X11 client of XWayland
  if (ozone) return ozone === 'wayland' ? 'wayland' : 'xwayland';
  if (electronMajor >= 38) return 'wayland';
  return env.DISPLAY ? 'xwayland' : 'wayland';
}

// What this build implements on `platform`: nothing system-dependent at the start. 
// Window tracking is switched on by its watcher (windows.js) once it runs.
function detect({ platform = process.platform, env = process.env, ozone = null } = {}) {
  const linux = platform === 'linux';
  return {
    platform,
    session: linuxSession(env, ozone),
    features: {
      ...Object.fromEntries(FEATURES.map((name) => [name, false])),
      // What works by itself on Linux (the rest is switched on by the KWin watcher: 
      // windowTracking, appList, appClose; see main.js)
      appLaunch: linux,   // the .desktop files, and Steam's library (linux/desktop-entries.js)
      mediaKeys: linux,   // MPRIS players over D-Bus, the volume through PipeWire/PulseAudio (linux/media.js)
      ollamaLaunch: linux, // In a terminal window (setup.js)
    },
  };
}

function createCapabilities(options = {}) {
  const base = detect(options);
  const runtime = {}; // what adapters reported since: feature -> boolean
  const listeners = new Set();

  const features = () => ({ ...base.features, ...runtime });

  return {
    platform: base.platform,
    session: base.session,

    // { feature: boolean } for every feature
    all: features,

    has(name) {
      if (!FEATURES.includes(name)) throw new Error(`unknown capability: ${name}`);
      return features()[name];
    },

    // An adapter started (true) or gave up (false). Listeners hear of real changes only.
    set(name, value) {
      if (!FEATURES.includes(name)) throw new Error(`unknown capability: ${name}`);
      const before = features()[name];
      runtime[name] = Boolean(value);
      if (before !== runtime[name]) listeners.forEach((fn) => fn(name, runtime[name]));
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Only what the overlay acts on, as plain booleans.
    forRenderer() {
      const f = features();
      return {
        windows: f.windowTracking,
        possess: f.windowTracking,
        closeApps: f.appList && f.appClose,
        launchApps: f.appLaunch,
        mediaKeys: f.mediaKeys,
        ollamaLaunch: f.ollamaLaunch,
      };
    },
  };
}

module.exports = { FEATURES, detect, linuxSession, ozonePlatform, createCapabilities };
