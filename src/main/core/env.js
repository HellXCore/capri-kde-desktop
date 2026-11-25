'use strict';

// The environment, turned into facts once at startup: which display server Electron is on, which
// desktop is around it, and whether it is the Plasma this port targets. This is the only place
// these variables are read; everything downstream is handed the facts, so every branch can be
// exercised by a test with a plain object. A hint the desktop may have ignored
// (ELECTRON_OZONE_PLATFORM_HINT) and dev forcing (CAPRI_FORCE_MODE) are not environment facts.

/** @typedef {'wayland'|'xwayland'|'x11'|'none'} Server */
/** @typedef {'kde'|'other'} Desktop */
/** @typedef {{ server: Server, desktop: Desktop, plasma: 6|null, ozone: 'x11'|'wayland'|null }} EnvFacts */

/**
 * @param {{ env: Record<string, string|undefined>, ozone: 'x11'|'wayland'|null, electronMajor: number }} i
 * @returns {EnvFacts}
 */
function detectEnv({ env, ozone, electronMajor }) {
  const waylandDesktop = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  /** @type {Server} */
  let server;
  if (!waylandDesktop) server = env.DISPLAY || env.XDG_SESSION_TYPE === 'x11' ? 'x11' : 'none';
  else if (ozone) server = ozone === 'wayland' ? 'wayland' : 'xwayland';
  else server = electronMajor >= 38 ? 'wayland' : env.DISPLAY ? 'xwayland' : 'wayland';
  const isKde = /KDE/i.test(env.XDG_CURRENT_DESKTOP || '');
  // Only Plasma 6 is the targeted desktop; 5 and anything else are left to honest degradation.
  const plasma = isKde && Number(env.KDE_SESSION_VERSION) === 6 ? 6 : null;
  return { server, desktop: isKde ? 'kde' : 'other', plasma, ozone };
}

/**
 * What Electron itself was asked to run on: the --ozone-platform flag on its command line, when it
 * names one of the two servers. 'auto', anything else, or no app to ask yet: null (not known).
 * This is the flag Electron actually got — not the desktop's session, and not a hint it may have
 * ignored. Reads no environment variable; the caller hands the app in.
 * @param {{ commandLine?: { getSwitchValue?: (key: string) => string } } | null | undefined} app
 * @returns {'x11'|'wayland'|null}
 */
function ozonePlatform(app) {
  try {
    const asked = app?.commandLine?.getSwitchValue?.('ozone-platform');
    if (asked === 'x11' || asked === 'wayland') return asked;
  } catch {
    // intentional: the switch is not readable yet (no app, or asked too early): not known
  }
  return null;
}

/**
 * The desktop names XDG_CURRENT_DESKTOP lists, in order ('KDE:GNOME' -> ['KDE', 'GNOME']). The raw
 * tokens, for a consumer that matches against them (a .desktop file's OnlyShowIn / NotShowIn); the
 * normalized fact is detectEnv's `desktop`. Empty when the variable is unset.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function desktopTokens(env) {
  return String(env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean);
}

module.exports = { detectEnv, ozonePlatform, desktopTokens };