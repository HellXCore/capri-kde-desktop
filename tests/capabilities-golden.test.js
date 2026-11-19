'use strict';

// Capabilities.js does pinned before its internals are reworked: the session it detects
// for every combination of environment, and what it reports for each platform. A failure here means
// behaviour changed — decide that on purpose, do not just edit the expectation.
//
// Runner: plain Node (`npm test`). process.versions.electron is absent there, so detect()
// resolves its default electronMajor to 0. The matrix pins every major explicitly; detect()
// assertions pick the slice matching the runner, so the file also holds under Electron.
//
// set() is exercised only where the mode allows the feature; forbidden cells are covered in
// capabilities-axes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURES, detect, linuxSession, ozonePlatform, createCapabilities } = require('../src/main/capabilities');

// ---------- env matrix: XDG_SESSION_TYPE x WAYLAND_DISPLAY x DISPLAY x ozone x electronMajor ----------
// Row: [XDG_SESSION_TYPE, WAYLAND_DISPLAY, DISPLAY, expectations].
// `undefined` = variable absent, '' = present but empty (both falsy today — pinned on purpose).
// Expectations order: ozone [null, 'wayland', 'x11'] outer, electronMajor [0, 37, 38, 44] inner.
const OZONE = [null, 'wayland', 'x11'];
const MAJORS = [0, 37, 38, 44];
const SESSION_GOLDEN = [
  // --- XDG_SESSION_TYPE absent ---
  [undefined, undefined, undefined, [null, null, null, null, null, null, null, null, null, null, null, null]],
  [undefined, undefined, '', [null, null, null, null, null, null, null, null, null, null, null, null]],
  [undefined, undefined, ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  [undefined, '', undefined, [null, null, null, null, null, null, null, null, null, null, null, null]],
  [undefined, '', '', [null, null, null, null, null, null, null, null, null, null, null, null]],
  [undefined, '', ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  [undefined, 'wayland-0', undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  [undefined, 'wayland-0', '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  [undefined, 'wayland-0', ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  // --- XDG_SESSION_TYPE empty (falsy, as absent) ---
  ['', undefined, undefined, [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['', undefined, '', [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['', undefined, ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['', '', undefined, [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['', '', '', [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['', '', ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['', 'wayland-0', undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['', 'wayland-0', '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['', 'wayland-0', ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  // --- XDG_SESSION_TYPE='wayland' (a Wayland desktop whatever WAYLAND_DISPLAY says) ---
  ['wayland', undefined, undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', undefined, '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', undefined, ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', '', undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', '', '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', '', ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', 'wayland-0', undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', 'wayland-0', '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['wayland', 'wayland-0', ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  // --- XDG_SESSION_TYPE='x11' ---
  ['x11', undefined, undefined, ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['x11', undefined, '', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['x11', undefined, ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['x11', '', undefined, ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['x11', '', '', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['x11', '', ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['x11', 'wayland-0', undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['x11', 'wayland-0', '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['x11', 'wayland-0', ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  // --- XDG_SESSION_TYPE='tty' (non-graphical) ---
  ['tty', undefined, undefined, [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['tty', undefined, '', [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['tty', undefined, ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['tty', '', undefined, [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['tty', '', '', [null, null, null, null, null, null, null, null, null, null, null, null]],
  ['tty', '', ':0', ['x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11', 'x11']],
  ['tty', 'wayland-0', undefined, ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['tty', 'wayland-0', '', ['wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
  ['tty', 'wayland-0', ':0', ['xwayland', 'xwayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'wayland', 'xwayland', 'xwayland', 'xwayland', 'xwayland']],
];

const envOf = ([xdg, wl, disp]) => {
  const env = {};
  if (xdg !== undefined) env.XDG_SESSION_TYPE = xdg;
  if (wl !== undefined) env.WAYLAND_DISPLAY = wl;
  if (disp !== undefined) env.DISPLAY = disp;
  return env;
};

// The detector branches only at electronMajor >= 38: slots 0/37 are identical, 38/44 are identical.
const DEFAULT_MAJOR = Number(String(process.versions.electron || '').split('.')[0]) || 0;
const SLOT = DEFAULT_MAJOR >= 38 ? 2 : 0;

test('linuxSession: full env matrix (golden, 540 cases)', () => {
  for (const row of SESSION_GOLDEN) {
    const env = envOf(row);
    let i = 0;
    for (const ozone of OZONE) {
      for (const major of MAJORS) {
        assert.equal(linuxSession(env, ozone, major), row[3][i], JSON.stringify({ env, ozone, major }));
        i += 1;
      }
    }
  }
});

test('linuxSession: default electronMajor follows the runner (golden slice)', () => {
  for (const row of SESSION_GOLDEN) {
    const env = envOf(row);
    for (let o = 0; o < OZONE.length; o += 1) {
      assert.equal(linuxSession(env, OZONE[o]), row[3][o * MAJORS.length + SLOT],
        JSON.stringify({ env, ozone: OZONE[o], defaultMajor: DEFAULT_MAJOR }));
    }
  }
});

test('linuxSession: no env at all -> null (no display)', () => {
  assert.equal(linuxSession(), null);
});

// ---------- the dictionary ----------

test('FEATURES: the exact dictionary', () => {
  assert.deepEqual(FEATURES, [
    'windowTracking', 'appList', 'appClose', 'appLaunch', 'mediaKeys', 'autostart', 'ollamaInstall', 'ollamaLaunch',
  ]);
});

// ---------- ozonePlatform ----------

test('ozonePlatform: only x11/wayland recognized; auto and everything else -> null (golden)', () => {
  const app = (v) => ({ commandLine: { getSwitchValue: (k) => (k === 'ozone-platform' ? v : '') } });
  assert.equal(ozonePlatform(app('x11')), 'x11');
  assert.equal(ozonePlatform(app('wayland')), 'wayland');
  for (const v of ['auto', '', 'headless', undefined]) assert.equal(ozonePlatform(app(v)), null);
  assert.equal(ozonePlatform(null), null);
  assert.equal(ozonePlatform(undefined), null);
  assert.equal(ozonePlatform({}), null);
  assert.equal(ozonePlatform({ commandLine: { getSwitchValue: () => { throw new Error('too early'); } } }), null);
});

// ---------- detect ----------

const FEATURES_LINUX = {
  windowTracking: false, appList: false, appClose: false,
  appLaunch: true, mediaKeys: true,
  autostart: false, ollamaInstall: false, ollamaLaunch: true,
};
const FEATURES_OTHER = {
  windowTracking: false, appList: false, appClose: false,
  appLaunch: false, mediaKeys: false,
  autostart: false, ollamaInstall: false, ollamaLaunch: false,
};

test('detect: features per platform (golden)', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const d = detect({ platform, env: {}, ozone: null });
    assert.equal(d.platform, platform);
    assert.deepEqual(d.features, platform === 'linux' ? FEATURES_LINUX : FEATURES_OTHER);
  }
});

test('detect: session ignores platform (quirk pinned) and matches the runner slice', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const row of SESSION_GOLDEN) {
      const env = envOf(row);
      for (let o = 0; o < OZONE.length; o += 1) {
        assert.equal(detect({ platform, env, ozone: OZONE[o] }).session, row[3][o * MAJORS.length + SLOT],
          JSON.stringify({ platform, env, ozone: OZONE[o] }));
      }
    }
  }
});

test('detect: defaults to this process platform', () => {
  assert.equal(detect().platform, process.platform);
});

test('detect: ELECTRON_OZONE_PLATFORM_HINT does not change the session', () => {
  const base = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
  const without = detect({ platform: 'linux', env: base, ozone: null });
  for (const hint of ['x11', 'wayland', 'auto']) {
    assert.deepEqual(detect({ platform: 'linux', env: { ...base, ELECTRON_OZONE_PLATFORM_HINT: hint }, ozone: null }), without);
  }
});

// ---------- the managed-window flag (main.js) ----------
// main.js cannot be required without Electron, so this mirrors its expression: the KWin adapter's
// declaration, fed REAL linuxSession() output through createCapabilities. One expectation changed
// on purpose when the flag moved to the contracts: with no display server nothing is managed —
// KWin needs a display to run on, and the old `session !== 'x11'` check let a null session through,
// leaving Ctrl+Alt+C owned by nobody (no script to start, no Electron registration).

const managed = (platform, env, ozone = null) =>
  createCapabilities({ platform, env, ozone }).adapters().includes('kwin');

test('managed window: no display server is not managed, even on a KDE desktop', () => {
  assert.equal(linuxSession({}, null, 44), null); // no display at all
  assert.equal(managed('linux', { XDG_CURRENT_DESKTOP: 'KDE' }), false);
});

test('managed window: the KWin adapter on wayland/xwayland KDE only', () => {
  const wl = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };
  const cases = [
    ['linux', { ...wl, XDG_CURRENT_DESKTOP: 'KDE' }, 'wayland', true],
    ['linux', { ...wl, XDG_CURRENT_DESKTOP: 'KDE' }, 'x11', true],
    ['linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, null, false],
    ['linux', { XDG_CURRENT_DESKTOP: 'KDE' }, null, false], // no display: changed on purpose
    ['linux', { ...wl, XDG_CURRENT_DESKTOP: 'kde' }, 'wayland', true], // the regex is case-insensitive
    ['linux', { ...wl, XDG_CURRENT_DESKTOP: 'GNOME' }, 'wayland', false],
    ['linux', { ...wl, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'wayland', false],
    ['linux', wl, 'wayland', false],
    ['linux', {}, null, false],
    ['win32', { XDG_CURRENT_DESKTOP: 'KDE' }, null, false],
  ];
  for (const [p, env, ozone, want] of cases) {
    assert.equal(managed(p, env, ozone), want, JSON.stringify({ p, env, ozone }));
  }
});

// ---------- createCapabilities ----------

const KDE_WAYLAND = {
  platform: 'linux',
  env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' },
  ozone: 'wayland',
};
const RENDERER_BASE_LINUX = { windows: false, possess: false, closeApps: false, launchApps: true, mediaKeys: true, ollamaLaunch: true };

test('capabilities: base state is detect(); session/platform are static facts', () => {
  const caps = createCapabilities(KDE_WAYLAND);
  assert.equal(caps.platform, 'linux');
  assert.equal(caps.session, 'wayland');
  assert.deepEqual(caps.all(), FEATURES_LINUX);
  caps.set('windowTracking', true);
  assert.equal(caps.session, 'wayland'); // set() never touches the facts
  assert.equal(caps.platform, 'linux');
});

test('capabilities: unknown features throw (screenshot is NOT a capability)', () => {
  const caps = createCapabilities(KDE_WAYLAND);
  assert.throws(() => caps.has('screenshot'), /unknown capability/);
  assert.throws(() => caps.set('screenshot', true), /unknown capability/);
  assert.throws(() => caps.has('nope'), /unknown capability/);
  assert.throws(() => caps.set('nope', true), /unknown capability/);
});

test('capabilities: set() coerces to boolean and notifies only on real change', () => {
  const caps = createCapabilities({ platform: 'linux', env: {}, ozone: null });
  const events = [];
  caps.onChange((name, value) => events.push([name, value]));
  caps.set('mediaKeys', 1);          // true -> true: no event
  caps.set('mediaKeys', 0);          // true -> false
  caps.set('mediaKeys', false);      // false -> false: no event
  caps.set('mediaKeys', 'yes');      // false -> true
  caps.set('windowTracking', false); // base false: no event
  assert.deepEqual(events, [['mediaKeys', false], ['mediaKeys', true]]);
  assert.equal(caps.all().mediaKeys, true);
  assert.equal(caps.has('mediaKeys'), true);
});

test('capabilities: onChange unsubscribe stops delivery; every listener hears a change', () => {
  const caps = createCapabilities({ platform: 'linux', env: {}, ozone: null });
  let a = 0;
  let b = 0;
  const off = caps.onChange(() => { a += 1; });
  caps.onChange(() => { b += 1; });
  caps.set('appLaunch', false);
  off();
  caps.set('appLaunch', true);
  assert.equal(a, 1);
  assert.equal(b, 2);
});

test('capabilities: runtime overrides base in all()/has()/forRenderer()', () => {
  const caps = createCapabilities({ platform: 'linux', env: {}, ozone: null });
  caps.set('appLaunch', false);
  assert.equal(caps.all().appLaunch, false);
  assert.equal(caps.has('appLaunch'), false);
  assert.equal(caps.forRenderer().launchApps, false);
});

test('capabilities: forRenderer shape and alias map (golden)', () => {
  const caps = createCapabilities(KDE_WAYLAND);
  assert.deepEqual(caps.forRenderer(), RENDERER_BASE_LINUX);
  // closeApps = appList && appClose: both required
  caps.set('appList', true);
  assert.equal(caps.forRenderer().closeApps, false);
  caps.set('appClose', true);
  assert.equal(caps.forRenderer().closeApps, true);
  caps.set('appList', false);
  assert.equal(caps.forRenderer().closeApps, false);
  // windowTracking drives both windows and possess
  caps.set('windowTracking', true);
  const r = caps.forRenderer();
  assert.equal(r.windows, true);
  assert.equal(r.possess, true);
  assert.deepEqual(Object.keys(r).sort(), ['closeApps', 'launchApps', 'mediaKeys', 'ollamaLaunch', 'possess', 'windows']);
});

test('capabilities: x11 base — tracking off until the watcher reports; no app list/close (golden)', () => {
  const caps = createCapabilities({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, ozone: null });
  assert.equal(caps.session, 'x11');
  assert.equal(caps.has('windowTracking'), false);
  assert.equal(caps.forRenderer().closeApps, false); // no KWin: appList/appClose stay off (§4.2)
  caps.set('windowTracking', true); // x11-watch reports in: legal in mode x11
  assert.equal(caps.forRenderer().windows, true);
  assert.equal(caps.forRenderer().closeApps, false);
});

test('capabilities: non-KDE wayland base — universal features only (golden)', () => {
  const caps = createCapabilities({
    platform: 'linux',
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' },
    ozone: 'wayland',
  });
  assert.equal(caps.session, 'wayland');
  assert.deepEqual(caps.forRenderer(), RENDERER_BASE_LINUX);
});
