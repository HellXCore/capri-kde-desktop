'use strict';

// detectEnv (core/env.js): the environment as facts. The server it names must agree with the one
// the running app detects today (capabilities.linuxSession) on every input of the golden matrix —
// 'none' where that one says null. Plasma is 6 only for a KDE desktop that says version 6.

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectEnv } = require('../src/main/core/env');
const { linuxSession } = require('../src/main/capabilities');

// The golden matrix's domain (capabilities-golden.test.js): 5 x 3 x 3 environments, each under
// 3 ozone flags and 4 Electron majors — 540 cases. undefined = absent, '' = present but empty.
const XDG = [undefined, '', 'wayland', 'x11', 'tty'];
const WL = [undefined, '', 'wayland-0'];
const DISP = [undefined, '', ':0'];
const OZONE = [null, 'wayland', 'x11'];
const MAJORS = [0, 37, 38, 44];

const envOf = (xdg, wl, disp) => {
  const env = {};
  if (xdg !== undefined) env.XDG_SESSION_TYPE = xdg;
  if (wl !== undefined) env.WAYLAND_DISPLAY = wl;
  if (disp !== undefined) env.DISPLAY = disp;
  return env;
};

test('server: agrees with linuxSession on the whole golden matrix (540 cases)', () => {
  let n = 0;
  for (const xdg of XDG) for (const wl of WL) for (const disp of DISP) {
    const env = envOf(xdg, wl, disp);
    for (const ozone of OZONE) for (const electronMajor of MAJORS) {
      const want = linuxSession(env, ozone, electronMajor) ?? 'none';
      const facts = detectEnv({ env, ozone, electronMajor });
      assert.equal(facts.server, want, JSON.stringify({ env, ozone, electronMajor }));
      n += 1;
    }
  }
  assert.equal(n, 540);
});

// The branches worth naming: [env, ozone, electronMajor, server]
const SERVER_TABLE = [
  [{ DISPLAY: ':0' }, null, 44, 'x11'],
  [{ XDG_SESSION_TYPE: 'x11' }, null, 44, 'x11'], // said x11, DISPLAY not set yet
  [{}, null, 44, 'none'],
  [{ XDG_SESSION_TYPE: 'tty' }, null, 44, 'none'],
  [{ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, 'x11', 44, 'xwayland'],
  [{ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, null, 44, 'wayland'], // 38+: native by default
  [{ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, null, 37, 'xwayland'], // older: an X client
  [{ WAYLAND_DISPLAY: 'wayland-0' }, null, 37, 'wayland'], // no DISPLAY: native anyway
  [{ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }, null, 44, 'wayland'], // Wayland wins
];

test('server: the named branches', () => {
  for (const [env, ozone, electronMajor, server] of SERVER_TABLE) {
    assert.equal(detectEnv({ env, ozone, electronMajor }).server, server,
      JSON.stringify({ env, ozone, electronMajor }));
  }
});

// [XDG_CURRENT_DESKTOP, KDE_SESSION_VERSION, desktop, plasma]
const KDE_TABLE = [
  ['KDE', '6', 'kde', 6],
  ['KDE', '5', 'kde', null],
  ['KDE', '', 'kde', null],
  ['KDE', undefined, 'kde', null],
  ['kde', '6', 'kde', 6], // the name is matched case-insensitively, as today
  ['KDE:GNOME', '6', 'kde', 6],
  ['KDE', '7', 'kde', null],
  ['KDE', '6.1', 'kde', null],
  ['KDE', 'six', 'kde', null],
  ['GNOME', '6', 'other', null], // a Plasma version without KDE means nothing
  ['ubuntu:GNOME', undefined, 'other', null],
  ['', '6', 'other', null],
  [undefined, '6', 'other', null],
];

test('desktop and plasma: KDE by name, Plasma 6 only by its version', () => {
  for (const [xdg, ver, desktop, plasma] of KDE_TABLE) {
    const env = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };
    if (xdg !== undefined) env.XDG_CURRENT_DESKTOP = xdg;
    if (ver !== undefined) env.KDE_SESSION_VERSION = ver;
    const facts = detectEnv({ env, ozone: 'wayland', electronMajor: 44 });
    assert.equal(facts.desktop, desktop, JSON.stringify({ xdg, ver }));
    assert.equal(facts.plasma, plasma, JSON.stringify({ xdg, ver }));
  }
});

test('the facts are exactly server, desktop, plasma, ozone; ozone is echoed as given', () => {
  const env = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' };
  for (const ozone of OZONE) {
    const facts = detectEnv({ env, ozone, electronMajor: 44 });
    assert.deepEqual(Object.keys(facts).sort(), ['desktop', 'ozone', 'plasma', 'server']);
    assert.equal(facts.ozone, ozone);
  }
});

test('a pure function: the same input gives the same facts, the env object is left as it is', () => {
  const env = Object.freeze({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' });
  const a = detectEnv({ env, ozone: null, electronMajor: 44 });
  assert.deepEqual(a, { server: 'wayland', desktop: 'kde', plasma: 6, ozone: null });
  assert.deepEqual(detectEnv({ env, ozone: null, electronMajor: 44 }), a);
});