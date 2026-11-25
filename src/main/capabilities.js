'use strict';

const { detectEnv, ozonePlatform } = require('./core/env');

// Deprecated: the transitional capability matrix, kept for the legacy shell only. Its feature API
// (all/has/set/onChange/forRenderer) is consumed by platform/shell/legacy-shell.js and the adapters
// it drives; everything else asks core/availability.js over the DesktopShell port. The composition
// root still constructs it and hands it to the shell. Removed when the platform agent lands.

// Which display server Electron runs on, and which desktop is around it. Decided once at startup:
// a different server means a restart with another --ozone-platform. Nothing outside this file
// guesses at the environment.

// Every feature that depends on the system. Anything not here (the overlay, hooks, chat, reminders,
// opening folders, files and websites) works everywhere.
const FEATURES = [
  'windowTracking', // other windows' geometry and the one in front (sitting on them, possession, demo)
  'appList',        // the apps with a window open, by name
  'appClose',       // closing one of them
  'appLaunch',      // installed apps and games (.desktop entries, Steam)
  'mediaKeys',      // play/pause, next, volume, as media keys
  'autostart',      // starting with the system (Linux needs ~/.config/autostart: not implemented)
  'ollamaInstall',  // installing Ollama with no terminal (no such path on Linux: see setup.js)
  'ollamaLaunch',   // Claude Code or Codex through Ollama, in a terminal window of its own
];

// The servers Electron can run on here. 'none': no display at all.
const SERVERS = ['wayland', 'xwayland', 'x11', 'none'];

// What works on Linux without any adapter, whatever the server: these three work on their own,
// and these two have no Linux implementation at all, so nothing may switch them on.
const UNIVERSAL = {
  appLaunch: true, mediaKeys: true, ollamaLaunch: true,
  autostart: false, ollamaInstall: false,
};

// One row, in FEATURES order. A cell not named here is off.
const cells = (over) => Object.fromEntries(FEATURES.map((name) => [name, over[name] ?? false]));

// What each server can do in any desktop. A cell is false (not possible here), true (works on its
// own), or 'adapter' (possible, off until an adapter that does it reports in). input and shortcut
// are the mechanisms the wiring reads; they are not features.
const SERVER_BASE = {
  wayland: { features: cells(UNIVERSAL), input: 'none', shortcut: 'electron' },
  xwayland: { features: cells(UNIVERSAL), input: 'xshape', shortcut: 'electron' },
  x11: { features: cells({ ...UNIVERSAL, windowTracking: 'adapter' }), input: 'xshape', shortcut: 'electron' },
  none: { features: cells(UNIVERSAL), input: 'none', shortcut: 'electron' },
};

// A desktop's overlay, per server it applies to: it may only raise false cells to 'adapter' and
// name a mechanism, never touch a true one. KDE on X11 has none: the KWin script is not used there.
const DESKTOP_OVERLAY = {
  kde: {
    wayland: { features: { windowTracking: 'adapter', appList: 'adapter', appClose: 'adapter' }, input: 'toggle', shortcut: 'adapter' },
    xwayland: { features: { windowTracking: 'adapter', appList: 'adapter', appClose: 'adapter' }, shortcut: 'adapter' },
  },
};

// The adapters that may run, as declarations: data and pure predicates over the facts, no I/O.
// adapters.js owns the factories; provides is what an adapter may report with set(), priority
// orders them when more than one matches the same facts.
const ADAPTERS = {
  kwin: {
    matches: (f) => f.desktop === 'kde' && (f.server === 'wayland' || f.server === 'xwayland'),
    provides: ['windowTracking', 'appList', 'appClose'],
    priority: 100,
  },
  x11: { matches: (f) => f.server === 'x11', provides: ['windowTracking'], priority: 50 },
};

// 'other': a desktop without an overlay of its own. A new desktop value comes with its overlay
// and its adapter, not before.
const DESKTOPS = ['other', ...Object.keys(DESKTOP_OVERLAY)];

const hasOverlay = (desktop, server) =>
  Object.hasOwn(DESKTOP_OVERLAY, desktop) && Object.hasOwn(DESKTOP_OVERLAY[desktop], server);

// The name of a server x desktop intersection: for logs, About and tests. A pure function of the
// facts, never a state to branch on.
function signature({ server, desktop }) {
  if (server === 'x11' || server === 'none') return server;
  if (hasOverlay(desktop, server)) return `${server}-${desktop}`;
  return server === 'wayland' ? 'wayland-generic' : 'xwayland-compat';
}

// The ceiling for a pair of facts: the base row, raised by the desktop's overlay where there is
// one. An overlay that lowers a cell or touches a true one is a broken declaration.
function ceilingFor({ server, desktop }, platform) {
  if (platform !== 'linux') return null;
  const base = SERVER_BASE[server];
  if (!hasOverlay(desktop, server)) return base;
  const over = DESKTOP_OVERLAY[desktop][server];
  const features = { ...base.features };
  for (const [name, cell] of Object.entries(over.features || {})) {
    if (base.features[name] !== false || cell !== 'adapter') {
      throw new Error(`desktop overlay may only raise false to 'adapter': ${desktop}/${server} ${name}`);
    }
    features[name] = cell;
  }
  return { features, input: over.input ?? base.input, shortcut: over.shortcut ?? base.shortcut };
}

// CAPRI_FORCE_MODE (dev only): a signature ('wayland-generic') or a server:desktop pair
// ('x11:kde'). It forces the policy facts, never the display server Electron really runs on.
function forcedFacts(asked) {
  if (!asked) return null;
  if (asked.includes(':')) {
    const parts = asked.split(':');
    if (parts.length === 2 && SERVERS.includes(parts[0]) && DESKTOPS.includes(parts[1])) {
      return { server: parts[0], desktop: parts[1] };
    }
    return null;
  }
  for (const server of SERVERS) {
    for (const desktop of DESKTOPS) {
      if (signature({ server, desktop }) === asked) return { server, desktop };
    }
  }
  return null;
}

// What the overlay is told, in its own words. Generated from FEATURES, so the two lists cannot
// drift apart.
/** @deprecated the renderer's vocabulary now lives in core/availability.js (rendererCaps). */
const RENDERER_ALIASES = {
  windows: (f) => f.windowTracking,
  possess: (f) => f.windowTracking,
  closeApps: (f) => f.appList && f.appClose,
  launchApps: (f) => f.appLaunch,
  mediaKeys: (f) => f.mediaKeys,
  ollamaLaunch: (f) => f.ollamaLaunch,
};

// Dev or tests: strict ceilings, and CAPRI_FORCE_MODE. No Electron here (this module is loaded by
// `node --test` as well): process.defaultApp is Electron's "started unpackaged" sign, and a process
// without process.versions.electron is a test or a script.
const isDev = (proc = process) => proc.argv.includes('--dev') || proc.defaultApp === true || !proc.versions?.electron;

// The session on Linux: 'x11' (Electron on a real X11 desktop), 'xwayland' (Electron on x11 in 
// a Wayland desktop, partial functionality), 'wayland' (Electron native), or null (no display).
// Native Wayland windows are out of reach of X11 calls, so the use of an external adapter.
// Electron does by itself, which is native Wayland in a Wayland desktop from version 38 on
// (its --ozone-platform default is "auto"), x11 before.
function linuxSession(env = {}, ozone = null, electronMajor = Number(String(process.versions.electron || '').split('.')[0]) || 0) {
  const server = detectEnv({ env, ozone, electronMajor }).server;
  return server === 'none' ? null : server;
}

// What works here before anything has started: the facts' own features, with the adapter ones
// still off. ELECTRON_OZONE_PLATFORM_HINT is not read — what Electron actually got on its command
// line is what counts, a hint it may have ignored is not.
function detect({ platform = process.platform, env = process.env, ozone = null, dev = isDev(), log = console } = {}) {
  const linux = platform === 'linux';
  const electronMajor = Number(String(process.versions.electron || '').split('.')[0]) || 0;
  const envFacts = detectEnv({ env, ozone, electronMajor });
  const session = envFacts.server === 'none' ? null : envFacts.server;
  const kde = envFacts.desktop === 'kde';
  const detected = { server: envFacts.server, desktop: envFacts.desktop };
  const asked = env.CAPRI_FORCE_MODE;
  const forced = linux && dev ? forcedFacts(asked) : null;
  if (asked && !forced) log.warn?.(`[capri] CAPRI_FORCE_MODE=${asked} ignored (unknown mode, or not a dev run)`);
 if (forced) log.log?.(`[capri] mode forced: ${signature(forced)} (CAPRI_FORCE_MODE; the session stays ${session || 'none'})`);
  const facts = forced || detected;
  const ceiling = ceilingFor(facts, platform);
  return {
    platform,
    session, // deprecated: the real server, 'none' as null
    kde,     // deprecated: the desktop as detected, before any force
    facts,
    signature: signature(facts),
    features: Object.fromEntries(FEATURES.map((name) => [name, ceiling?.features[name] === true])),
  };
}
/** @deprecated transitional: the legacy shell's feature matrix; see core/availability.js. */
function createCapabilities(options = {}) {
  const base = detect(options);
  const dev = options.dev ?? isDev();
  const log = options.log ?? console;
  const facts = Object.freeze({ ...base.facts });
  const policy = ceilingFor(facts, base.platform);
  const ceiling = policy?.features || {};
  const runtime = {}; // what adapters reported since: feature -> boolean
  const listeners = new Set();

  const features = () => ({ ...base.features, ...runtime });
  const sig = () => signature(facts);

  return {
    platform: base.platform,
    facts,
    get signature() { return sig(); },

    // Deprecated until their consumers are migrated: the real server ('none' as null), the
    // signature as the old mode name ('none' as null), and the desktop as detected.
    session: base.session,
    get mode() { const s = sig(); return s === 'none' ? null : s; },
    kde: base.kde,

    // Which adapters these facts may run, by priority. Names only: nothing is loaded or started.
    adapters: () => (base.platform === 'linux'
      ? Object.entries(ADAPTERS)
        .filter(([, a]) => a.matches(facts))
        .sort(([, a], [, b]) => b.priority - a.priority)
        .map(([id]) => id)
      : []),

    // The mechanisms the wiring reads (input region, shortcut owner). Not features.
    mechanisms: () => ({ input: policy?.input ?? 'none', shortcut: policy?.shortcut ?? 'electron' }),

    // { feature: boolean } for every feature
    all: features,

    has(name) {
      if (!FEATURES.includes(name)) throw new Error(`unknown capability: ${name}`);
      return features()[name];
    },

    // A feature is on only if the ceiling allows it and something has confirmed it. Turning one
    // off is always allowed: an adapter giving up is not a violation.
    set(name, value) {
      if (!FEATURES.includes(name)) throw new Error(`unknown capability: ${name}`);
      const cell = ceiling[name];
      const allowed = cell === true || cell === 'adapter';
      const next = allowed && Boolean(value);
      if (!allowed && Boolean(value)) {
        const why = `capability ${name} is not allowed in ${sig()} (${base.platform})`;
        if (dev) throw new Error(why);
        log.warn?.(`[capri] ${why}: ignored`);
        return;
      }
      const before = features()[name];
      runtime[name] = next;
      if (before !== next) listeners.forEach((fn) => fn(name, next));
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Only what the overlay acts on, as plain booleans.
    forRenderer() {
      const f = features();
      return Object.fromEntries(Object.entries(RENDERER_ALIASES).map(([key, read]) => [key, read(f)]));
    },
  };
}

module.exports = {
  FEATURES, SERVER_BASE, DESKTOP_OVERLAY, ADAPTERS, RENDERER_ALIASES,
  detect, signature, linuxSession, ozonePlatform, createCapabilities,
};
