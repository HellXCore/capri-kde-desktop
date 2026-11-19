'use strict';

// The two axes (server, desktop), the ceiling tables and CAPRI_FORCE_MODE. The golden file next to
// this one pins what must not change; this one pins what each intersection of the axes may do, and
// that the tables and the adapter declarations agree with each other.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEATURES, SERVER_BASE, DESKTOP_OVERLAY, ADAPTERS, RENDERER_ALIASES,
  signature, createCapabilities,
} = require('../src/main/capabilities');

const SERVERS = ['wayland', 'xwayland', 'x11', 'none'];
const DESKTOPS = ['other', 'kde'];
const silent = { log() {}, warn() {} };
const WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
const KDE_ENV = { ...WAYLAND, XDG_CURRENT_DESKTOP: 'KDE' };
const GNOME_ENV = { ...WAYLAND, XDG_CURRENT_DESKTOP: 'GNOME' };
const X11_ENV = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' };
const caps = (over) => createCapabilities({ platform: 'linux', env: KDE_ENV, ozone: 'wayland', log: silent, ...over });

// The derived matrix, row by row: what each intersection allows before any adapter reports in.
// adapterCells start off and may be turned on; the rest is universal (on) or forbidden.
const ROWS = {
  'wayland-kde': { adapters: ['kwin'], input: 'toggle', shortcut: 'adapter', adapterCells: ['windowTracking', 'appList', 'appClose'] },
  'wayland-generic': { adapters: [], input: 'none', shortcut: 'electron', adapterCells: [] },
  'xwayland-kde': { adapters: ['kwin'], input: 'xshape', shortcut: 'adapter', adapterCells: ['windowTracking', 'appList', 'appClose'] },
  'xwayland-compat': { adapters: [], input: 'xshape', shortcut: 'electron', adapterCells: [] },
  x11: { adapters: ['x11'], input: 'xshape', shortcut: 'electron', adapterCells: ['windowTracking'] },
  none: { adapters: [], input: 'none', shortcut: 'electron', adapterCells: [] },
};
const UNIVERSAL_ON = ['appLaunch', 'mediaKeys', 'ollamaLaunch'];
const FORBIDDEN = ['autostart', 'ollamaInstall'];

test('SERVER_BASE: every row is the whole dictionary, with the mechanisms named', () => {
  assert.deepEqual(Object.keys(SERVER_BASE).sort(), [...SERVERS].sort());
  for (const server of SERVERS) {
    const row = SERVER_BASE[server];
    assert.deepEqual(Object.keys(row.features), FEATURES, server);
    for (const name of UNIVERSAL_ON) assert.equal(row.features[name], true, `${server}.${name}`);
    for (const name of FORBIDDEN) assert.equal(row.features[name], false, `${server}.${name}`);
    assert.ok(['none', 'xshape', 'toggle'].includes(row.input), server);
    assert.ok(['electron', 'adapter'].includes(row.shortcut), server);
  }
  // an 'adapter' cell in the base needs an adapter that does not depend on the desktop
  assert.equal(SERVER_BASE.x11.features.windowTracking, 'adapter');
  for (const server of ['wayland', 'xwayland', 'none']) {
    for (const name of FEATURES) assert.notEqual(SERVER_BASE[server].features[name], 'adapter', `${server}.${name}`);
  }
});

test('DESKTOP_OVERLAY: only raises forbidden cells to adapter, never touches a true one', () => {
  for (const [desktop, servers] of Object.entries(DESKTOP_OVERLAY)) {
    for (const [server, over] of Object.entries(servers)) {
      for (const [name, cell] of Object.entries(over.features || {})) {
        assert.equal(cell, 'adapter', `${desktop}/${server}.${name}`);
        assert.equal(SERVER_BASE[server].features[name], false, `${desktop}/${server}.${name}`);
      }
    }
  }
});

test('the derived matrix: every server x desktop intersection, row by row', () => {
  for (const server of SERVERS) {
    for (const desktop of DESKTOPS) {
      const sig = signature({ server, desktop });
      const row = ROWS[sig];
      const where = `${server}:${desktop}`;
      const c = caps({ env: { ...KDE_ENV, CAPRI_FORCE_MODE: where } });
      assert.equal(c.signature, sig, where);
      assert.deepEqual(c.facts, { server, desktop }, where);
      assert.deepEqual(c.adapters(), row.adapters, where);
      assert.deepEqual(c.mechanisms(), { input: row.input, shortcut: row.shortcut }, where);
      // before any adapter reports: universal on, everything else off
      const base = Object.fromEntries(FEATURES.map((name) => [name, UNIVERSAL_ON.includes(name)]));
      assert.deepEqual(c.all(), base, where);
      for (const name of FEATURES) {
        if (row.adapterCells.includes(name)) {
          c.set(name, true);
          assert.equal(c.has(name), true, `${where} ${name}`);
          c.set(name, false);
        } else if (!UNIVERSAL_ON.includes(name)) {
          assert.throws(() => c.set(name, true), /not allowed/, `${where} ${name}`);
        }
      }
    }
  }
});

test('signature: a pure function of the facts, never changes with runtime state', () => {
  const expected = {
    'wayland:kde': 'wayland-kde', 'wayland:other': 'wayland-generic',
    'xwayland:kde': 'xwayland-kde', 'xwayland:other': 'xwayland-compat',
    'x11:kde': 'x11', 'x11:other': 'x11',
    'none:kde': 'none', 'none:other': 'none',
  };
  for (const [pair, sig] of Object.entries(expected)) {
    const [server, desktop] = pair.split(':');
    assert.equal(signature({ server, desktop }), sig, pair);
    assert.equal(signature({ server, desktop }), sig, pair);
  }
  const c = caps();
  const before = c.signature;
  c.set('windowTracking', true);
  assert.equal(c.signature, before);
});

test('adapter declarations: matches never overlap on a feature, provides are adapter cells', () => {
  for (const server of SERVERS) {
    for (const desktop of DESKTOPS) {
      const facts = { server, desktop };
      const matching = Object.entries(ADAPTERS).filter(([, a]) => a.matches(facts));
      const seen = new Set();
      for (const [id, a] of matching) {
        for (const name of a.provides) {
          assert.ok(!seen.has(name), `${id} overlaps on ${name} at ${server}:${desktop}`);
          seen.add(name);
          assert.ok(!UNIVERSAL_ON.includes(name), `${id} provides a universal cell: ${name}`);
          const c = caps({ env: { ...KDE_ENV, CAPRI_FORCE_MODE: `${server}:${desktop}` } });
          assert.equal(c.has(name), false, `${id}.${name} starts off`);
          c.set(name, true); // an adapter cell: allowed, never a forbidden one
          assert.equal(c.has(name), true);
        }
      }
    }
  }
});

test('caps.adapters(): a fresh copy, nothing created', () => {
  const c = caps();
  const a = c.adapters();
  assert.deepEqual(a, ['kwin']);
  a.push('x11');
  assert.deepEqual(c.adapters(), ['kwin']);
});

test('ceilings: a forbidden cell cannot be turned on (dev/tests throw)', () => {
  const c = caps({ env: GNOME_ENV });
  assert.equal(c.signature, 'wayland-generic');
  for (const name of ['windowTracking', 'appList', 'appClose', 'autostart', 'ollamaInstall']) {
    assert.throws(() => c.set(name, true), /not allowed/, name);
    assert.equal(c.has(name), false, name);
  }
});

test('ceilings: outside dev the same call is warned about and ignored', () => {
  const said = [];
  const c = caps({ env: GNOME_ENV, dev: false, log: { warn: (m) => said.push(m), log() {} } });
  let events = 0;
  c.onChange(() => { events += 1; });
  c.set('windowTracking', true);
  assert.equal(c.has('windowTracking'), false);
  assert.equal(events, 0);
  assert.equal(said.length, 1);
  assert.match(said[0], /windowTracking/);
});

test('ceilings: adapter cells go on when confirmed and off when the adapter gives up', () => {
  const c = caps();
  assert.equal(c.has('windowTracking'), false);
  c.set('windowTracking', true);
  assert.equal(c.has('windowTracking'), true);
  c.set('windowTracking', false); // the adapter gave up
  assert.equal(c.has('windowTracking'), false);
  c.set('mediaKeys', false); // a universal feature may be unavailable too
  assert.equal(c.has('mediaKeys'), false);
});

test('ceilings: a non-linux platform denies everything', () => {
  const c = createCapabilities({ platform: 'win32', env: {}, ozone: null, log: silent });
  for (const name of FEATURES) assert.throws(() => c.set(name, true), /not allowed/, name);
});

test('facts and deprecated aliases: session is the real server, mode the signature, kde the desktop', () => {
  const cases = [
    [KDE_ENV, 'wayland', 'wayland', 'wayland-kde', true],
    [GNOME_ENV, 'wayland', 'wayland', 'wayland-generic', false],
    [KDE_ENV, 'x11', 'xwayland', 'xwayland-kde', true],
    [GNOME_ENV, 'x11', 'xwayland', 'xwayland-compat', false],
    [X11_ENV, null, 'x11', 'x11', true],
    [{ XDG_CURRENT_DESKTOP: 'KDE' }, null, null, null, true],
    [{}, null, null, null, false],
  ];
  for (const [env, ozone, session, mode, kde] of cases) {
    const c = createCapabilities({ platform: 'linux', env, ozone, log: silent });
    const where = JSON.stringify({ env, ozone });
    assert.equal(c.session, session, where);
    assert.equal(c.mode, mode, where);
    assert.equal(c.kde, kde, where);
    assert.equal(c.facts.server, session || 'none', where);
  }
});

test('CAPRI_FORCE_MODE: a signature or a server:desktop pair forces the policy, never the session', () => {
  const bySignature = caps({ env: { ...KDE_ENV, CAPRI_FORCE_MODE: 'wayland-generic' } });
  assert.equal(bySignature.session, 'wayland'); // the real display server is untouched
  assert.equal(bySignature.signature, 'wayland-generic');
  assert.deepEqual(bySignature.adapters(), []);
  assert.throws(() => bySignature.set('windowTracking', true), /not allowed/);
  const byPair = caps({ env: { ...KDE_ENV, CAPRI_FORCE_MODE: 'x11:kde' } });
  assert.equal(byPair.session, 'wayland');
  assert.equal(byPair.signature, 'x11');
  assert.deepEqual(byPair.adapters(), ['x11']);
  assert.deepEqual(byPair.facts, { server: 'x11', desktop: 'kde' });
});

test('CAPRI_FORCE_MODE: ignored outside dev, and for anything unknown', () => {
  const said = [];
  const log = { warn: (m) => said.push(m), log() {} };
  const off = caps({ env: { ...KDE_ENV, CAPRI_FORCE_MODE: 'wayland-generic' }, dev: false, log });
  assert.equal(off.signature, 'wayland-kde');
  for (const bad of ['nope', '__proto__', 'constructor', 'x11:gnome', 'wayland:kde:extra']) {
    assert.equal(caps({ env: { ...KDE_ENV, CAPRI_FORCE_MODE: bad }, log }).signature, 'wayland-kde', bad);
  }
  assert.equal(said.length, 6);
});

test('forRenderer is generated from the alias map, not written twice', () => {
  assert.deepEqual(Object.keys(caps().forRenderer()), Object.keys(RENDERER_ALIASES));
});