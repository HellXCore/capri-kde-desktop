'use strict';

// core/availability.js: the backend's report gated by the agent's life cycle, and the renderer's
// projection of it. Pure — a fake report and every agent state, no desktop, no Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const { availability, rendererCaps } = require('../src/main/core/availability');

const REPORT = {
  tier: 1, backend: 'kwin', windows: true, pointer: true,
  apps: { list: true, close: true }, hotkey: true,
  screenshot: ['spectacle', 'portal'],
  overlay: { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' },
};
const STATES = ['idle', 'starting', 'ready', 'degraded', 'failed', 'stopped'];
const FEATURES = ['windowTracking', 'appList', 'appClose', 'appLaunch', 'mediaKeys', 'autostart', 'ollamaInstall', 'ollamaLaunch'];
const ALIASES = ['windows', 'possess', 'closeApps', 'launchApps', 'mediaKeys', 'ollamaLaunch'];

test('the feature dictionary is exactly the eight names, all booleans', () => {
  const a = availability(REPORT, 'ready');
  assert.deepEqual(Object.keys(a).sort(), [...FEATURES].sort());
  for (const v of Object.values(a)) assert.equal(typeof v, 'boolean');
});

test('only a ready agent offers what it must confirm; the universal ones stay', () => {
  for (const state of STATES) {
    const a = availability(REPORT, state);
    const live = state === 'ready';
    assert.equal(a.windowTracking, live, state);
    assert.equal(a.appList, live, state);
    assert.equal(a.appClose, live, state);
    assert.equal(a.appLaunch, true, state);
    assert.equal(a.mediaKeys, true, state);
    assert.equal(a.ollamaLaunch, true, state);
    assert.equal(a.autostart, false, state);
    assert.equal(a.ollamaInstall, false, state);
  }
});

test('a backend that cannot do something never offers it, even ready', () => {
  const bare = { ...REPORT, windows: false, apps: { list: false, close: false } };
  const a = availability(bare, 'ready');
  assert.equal(a.windowTracking, false);
  assert.equal(a.appList, false);
  assert.equal(a.appClose, false);
});

test('the renderer projection: its six names, windows and possess together, closeApps needs both', () => {
  const r = rendererCaps(availability(REPORT, 'ready'));
  assert.deepEqual(Object.keys(r).sort(), [...ALIASES].sort());
  assert.equal(r.windows, true);
  assert.equal(r.possess, true);
  assert.equal(r.closeApps, true);
  assert.equal(r.launchApps, true);
  const half = rendererCaps(availability({ ...REPORT, apps: { list: true, close: false } }, 'ready'));
  assert.equal(half.closeApps, false);
  const off = rendererCaps(availability(REPORT, 'degraded'));
  assert.deepEqual(off, { windows: false, possess: false, closeApps: false, launchApps: true, mediaKeys: true, ollamaLaunch: true });
});

test('pure: the report is not touched, the same input gives the same answer', () => {
  const frozen = Object.freeze({ ...REPORT, apps: Object.freeze({ ...REPORT.apps }) });
  const a = availability(frozen, 'ready');
  assert.deepEqual(a, availability(frozen, 'ready'));
  assert.deepEqual(rendererCaps(a), rendererCaps(a));
});