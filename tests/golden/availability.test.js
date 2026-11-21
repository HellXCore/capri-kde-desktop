'use strict';

// The equivalence the availability rewrite must hold: for every server × desktop intersection and
// every agent state, what the renderer is told now — rendererCaps(availability(shell.caps(), state))
// — is exactly what capabilities.forRenderer() said before, and the full feature map matches
// capabilities.all(). The old runtime mutations were the adapter confirming itself, which is the
// agent being ready; in every other state those cells were off. Driven through the real LegacyShell
// with a fake adapter, so the shell's own mapping is part of what is pinned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { availability, rendererCaps } = require('../../src/main/core/availability');
const { createCapabilities, FEATURES } = require('../../src/main/capabilities');
const { createLegacyShell } = require('../../src/main/platform/shell/legacy-shell');
const adapters = require('../../src/main/adapters');
const { BASE_METHODS } = require('../../src/main/linux/screenshot');

const silent = { log() {}, warn() {}, error() {} };
const SERVERS = ['wayland', 'xwayland', 'x11', 'none'];
const DESKTOPS = ['other', 'kde'];
const STATES = ['idle', 'starting', 'ready', 'degraded', 'failed', 'stopped'];
const CONFIRMS = { kwin: ['windowTracking', 'appList', 'appClose'], x11: ['windowTracking'] };

function makeShell(server, desktop) {
  const caps = createCapabilities({
    platform: 'linux',
    env: {
      XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0',
      XDG_CURRENT_DESKTOP: 'KDE', CAPRI_FORCE_MODE: `${server}:${desktop}`,
    },
    ozone: 'wayland',
    log: silent,
  });
  const [id] = caps.adapters();
  let wire = null;
  const factories = id ? {
    [id]: (deps) => {
      wire = deps;
      return {
        id, units: 'dip', provides: CONFIRMS[id], methods: {},
        apps: { windows: () => [], closeApps() {} },
        origin: () => null, cursor: () => null, focus() {}, setZones() {}, stop() {},
      };
    },
  } : {};
  const { shell } = createLegacyShell({
    caps, adapters, factories, log: silent,
    inputRegion: { chooseBackend: () => 'toggle' },
    screenshot: { BASE_METHODS, grab: async () => null },
    apps: { list: async () => [], close: async () => ({ running: false }) },
    overlay: {
      isDestroyed: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getNativeWindowHandle: () => Buffer.alloc(8),
      setTitle() {},
    },
  });
  return { shell, caps, id, confirm: () => wire && wire.onState(true) };
}

for (const server of SERVERS) {
  for (const desktop of DESKTOPS) {
    test(`${server}:${desktop} — availability equals the old capabilities in every agent state`, async () => {
      const m = makeShell(server, desktop);
      await m.shell.start();
      m.confirm(); // the adapter at its fullest: the report the ready agent would give
      const report = m.shell.caps();
      const cells = CONFIRMS[m.id] || [];
      for (const agent of STATES) {
        // the old world: adapter cells confirmed exactly when the agent is ready
        for (const cell of FEATURES) {
          if (cells.includes(cell)) m.caps.set(cell, agent === 'ready');
        }
        const a = availability(report, agent);
        assert.deepEqual(a, m.caps.all(), `${server}:${desktop} ${agent}: feature map`);
        assert.deepEqual(rendererCaps(a), m.caps.forRenderer(), `${server}:${desktop} ${agent}: renderer`);
      }
      await m.shell.stop();
    });
  }
}

test('main no longer asks the legacy matrix: the feature API is the shell\'s', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /caps\.(has|all|forRenderer|onChange)\(/);
});

// Quitting: the shell says 'stopped' from inside stop(), before it unsubscribes anyone. Her window is
// already destroyed by then, so a subscriber that broadcasts unconditionally throws out of will-quit.
test('quit: stop() reaches a broadcasting subscriber, and stopped is all it says', async () => {
  const m = makeShell('wayland', 'kde');
  await m.shell.start();
  const seen = [];
  m.shell.health.subscribe((h) => seen.push(h.state));
  // her window at will-quit: the reference is still there, what it points at is gone
  m.shell.health.subscribe(() => { throw new TypeError('Object has been destroyed'); });
  let caught = null;
  try { await m.shell.stop(); } catch (err) { caught = err; }
  assert.match(String(caught && caught.message), /destroyed/, 'stop() must reach the subscriber');
  assert.deepEqual(seen, ['stopped'], 'teardown says exactly one thing: skipping it silences the lot');
});

test('main does not broadcast on the shell\'s teardown', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('health.subscribe') && l.includes('broadcastConfig'));
  assert.ok(line, 'the shell health → broadcast subscription is gone');
  assert.match(line, /h\.state !== 'stopped'/, 'broadcasting on stopped throws out of will-quit');
});