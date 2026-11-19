'use strict';

// The flags main.js works out from the capabilities contracts, against what it used to work out
// from the session and the desktop name. Linux is the only platform this runs on; what varies is
// the environment. Every combination must give the same answer, except one deliberate change:
// with no display server nothing is managed — KWin needs a display to run on, and the old
// `session !== 'x11'` check let a null session through on a KDE desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCapabilities } = require('../src/main/capabilities');

// main.js
const kwinManaged = (c) => c.adapters().includes('kwin');
const nativeWayland = (c) => c.facts.server === 'wayland';
const adapterShortcut = (c) => c.mechanisms().shortcut === 'adapter';

// what they replace: LINUX_MANAGED and the session checks
const kde = (env) => /KDE/i.test(env.XDG_CURRENT_DESKTOP || '');
const wasManaged = (c, env) => c.platform === 'linux' && c.session !== 'x11' && kde(env);
const wasNative = (c) => c.session === 'wayland';

const XDG = [undefined, '', 'wayland', 'x11', 'tty'];
const WL = [undefined, '', 'wayland-0'];
const DISP = [undefined, '', ':0'];
const DE = [undefined, '', 'KDE', 'kde', 'GNOME', 'ubuntu:GNOME', 'KDE:GNOME'];
const OZONE = [null, 'wayland', 'x11'];

test('the managed-window flag agrees with the session and the desktop name, except with no display', () => {
  let n = 0;
  let unmanaged = 0;
  for (const x of XDG) for (const w of WL) for (const d of DISP) for (const de of DE) for (const ozone of OZONE) {
    const env = {};
    if (x !== undefined) env.XDG_SESSION_TYPE = x;
    if (w !== undefined) env.WAYLAND_DISPLAY = w;
    if (d !== undefined) env.DISPLAY = d;
    if (de !== undefined) env.XDG_CURRENT_DESKTOP = de;
    const c = createCapabilities({ platform: 'linux', env, ozone });
    const where = JSON.stringify({ env, ozone });
    if (c.facts.server === 'none') {
      // no display server: no compositor to manage the overlay, whatever the desktop name says
      assert.equal(kwinManaged(c), false, where);
      unmanaged += wasManaged(c, env) ? 1 : 0;
    } else {
      assert.equal(kwinManaged(c), wasManaged(c, env), where);
    }
    assert.equal(nativeWayland(c), wasNative(c), where);
    // the shortcut belongs to an adapter exactly where that adapter manages the window
    assert.equal(adapterShortcut(c), kwinManaged(c), where);
    // the input mechanism is only asked about where her window is a native Wayland one
    if (c.session === 'wayland') assert.equal(c.mechanisms().input === 'toggle', kde(env), where);
    n += 1;
  }
  assert.equal(n, 945);
  assert.equal(unmanaged, 108); // the KDE-with-no-display combinations the old flag called managed
});

test('a forced mode is a policy of its own, not a claim about the display server', () => {
  const base = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' };
  const c = createCapabilities({ platform: 'linux', env: { ...base, CAPRI_FORCE_MODE: 'wayland-generic' }, ozone: 'wayland' });
  assert.equal(c.session, 'wayland');
  assert.equal(nativeWayland(c), true);
  assert.equal(kwinManaged(c), false); // the script is not the one looking after her here
  assert.equal(adapterShortcut(c), false);
  const none = createCapabilities({ platform: 'linux', env: { ...base, CAPRI_FORCE_MODE: 'none:kde' }, ozone: 'wayland' });
  assert.equal(none.session, 'wayland'); // the real display server is untouched
  assert.equal(kwinManaged(none), false);
  assert.equal(adapterShortcut(none), false);
  assert.equal(nativeWayland(none), false);
});