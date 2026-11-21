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

module.exports = { detectEnv };