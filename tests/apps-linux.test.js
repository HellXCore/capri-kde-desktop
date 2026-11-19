'use strict';

// The open apps and closing one: the windows come from the adapter, handed in by the wiring.
// Nothing here may reach for the KWin half on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const apps = require('../src/main/linux/apps-linux');

const source = (wins) => {
  const closed = [];
  return { closed, windows: () => wins, closeApps: (pids) => closed.push(pids) };
};
const win = (over = {}) => ({ pid: 4242, cls: 'firefox', app: 'org.mozilla.firefox', types: ['NORMAL'], state: [], ...over });

test('one app per program, from the source it was given; the desktop\'s own pieces are left out', async () => {
  const w = source([
    win(), win({ pid: 4243 }),
    win({ pid: 5, cls: 'org.kde.konsole', app: 'org.kde.konsole.desktop' }),
    win({ pid: 7, cls: 'org.gnome.Nautilus', app: '' }), // no desktop file of its own: its window class
    win({ pid: 9, cls: 'org.kde.plasmashell', app: '' }),
    win({ pid: 11, cls: 'x', app: '', types: ['TOOLTIP'] }),
  ]);
  const list = await apps.list({ watch: w, desktop: { forWindow: () => ({ name: 'Firefox' }) } });
  // the name is the desktop file as the window source reports it (suffix and all), else the class
+  assert.deepEqual(list.map((a) => a.name), ['org.mozilla.firefox', 'org.kde.konsole.desktop', 'org.gnome.Nautilus']);
  assert.deepEqual(list[0].ids, [4242, 4243]);
  assert.equal(list[0].label, 'Firefox');
});

test('the KWin half is never loaded for the list of apps', () => {
  assert.equal(require.cache[require.resolve('../src/main/linux/kwin-bridge')], undefined);
});

test('no adapter: nothing listed, nothing closed', async () => {
  assert.deepEqual(await apps.list({}), []);
  assert.deepEqual(await apps.close('anything', {}), { running: false });
});

test('closing asks for that program\'s windows, each pid once', async () => {
  const w = source([win(), win({ pid: 4243 }), win({ pid: 4243 })]);
  const res = await apps.close('org.mozilla.firefox', { watch: w, wait: async () => {} });
  assert.deepEqual(w.closed, [[4242, 4243]]);
  assert.equal(typeof res.running, 'boolean');
});