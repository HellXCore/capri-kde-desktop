'use strict';

// What she can do right now, as plain booleans: the backend's own report (Capabilities), gated by
// the agent's life cycle. Nothing here knows which desktop or server is underneath — a feature the
// platform cannot offer is simply absent from the report. The universal ones (opening apps, media
// keys, running an assistant through Ollama) work on their own on Linux; autostart and installing
// Ollama have no implementation here, so nothing may switch them on.

/** @typedef {'windowTracking'|'appList'|'appClose'|'appLaunch'|'mediaKeys'|'autostart'|'ollamaInstall'|'ollamaLaunch'} Feature */
/** @typedef {Record<Feature, boolean>} Availability */
/** @typedef {{ windows: boolean, possess: boolean, closeApps: boolean, launchApps: boolean, mediaKeys: boolean, ollamaLaunch: boolean }} RendererCaps */

/**
 * The agent's report only counts while it is ready: a degraded, restarting or stopped agent offers
 * nothing it would have to confirm first.
 * @param {import('./ports').Capabilities} caps
 * @param {import('./ports').AgentState} agent
 * @returns {Availability}
 */
function availability(caps, agent) {
  const live = agent === 'ready';
  return {
    windowTracking: live && caps.windows,
    appList: live && caps.apps.list,
    appClose: live && caps.apps.close,
    appLaunch: true,
    mediaKeys: true,
    autostart: false,
    ollamaInstall: false,
    ollamaLaunch: true,
  };
}

/**
 * What the overlay is told, in its own words (the renderer's vocabulary).
 * @param {Availability} a
 * @returns {RendererCaps}
 */
function rendererCaps(a) {
  return {
    windows: a.windowTracking,
    possess: a.windowTracking,
    closeApps: a.appList && a.appClose,
    launchApps: a.appLaunch,
    mediaKeys: a.mediaKeys,
    ollamaLaunch: a.ollamaLaunch,
  };
}

module.exports = { availability, rendererCaps };