'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromPayload, toXPixels, startKWinWatch } = require('../src/main/linux/kwin-bridge');

const win = (types = [], state = []) => ({ types, state, desktop: null, pid: 1 });
const payload = () => ({
  v: 1,
  root: { active: 10, stacking: [10, 11, 12, 13, 14], desktop: null }, // front first
  infos: {
    10: win(),                    // a normal window: a seat
    11: win(['DOCK']),            // a panel: not a seat
    12: win(),                    // too small
    13: win([], ['HIDDEN']),      // minimized
    14: win([], ['MAXIMIZED_VERT', 'MAXIMIZED_HORZ']),
  },
  rects: {
    10: { x: 100, y: 80, w: 800, h: 600 },
    11: { x: 0, y: 0, w: 1920, h: 40 },
    12: { x: 5, y: 5, w: 100, h: 50 },
    13: { x: 0, y: 0, w: 800, h: 600 },
    14: { x: 0, y: 40, w: 1920, h: 1040 },
  },
  outputs: [{ x: 0, y: 0, w: 1920, h: 1080, s: 1 }],
  ai: ['chatgpt', 5],
});

test('kwin payload: seats in the Windows helper format, front first, others left out', () => {
  const snap = fromPayload(payload());
  assert.equal(snap.fg, 10);
  assert.deepEqual(snap.wins, [
    { id: 10, x: 100, y: 80, w: 800, h: 600, max: false },
    { id: 14, x: 0, y: 40, w: 1920, h: 1040, max: true },
  ]);
  assert.deepEqual(snap.ai, ['chatgpt']); // keys only, anything but a string dropped
  assert.equal(snap.game, null);
  assert.deepEqual(snap.usb, []);
});

test('kwin payload: a panel in front is reported as the taskbar', () => {
  const p = payload();
  p.root.active = 11;
  assert.equal(fromPayload(p).taskbar, true);
});

test('kwin payload: anything that is not version 1 is refused, garbage is dropped', () => {
  assert.throws(() => fromPayload(null), /unknown payload/);
  assert.throws(() => fromPayload({ v: 2 }), /unknown payload/);
  const p = payload();
  p.rects[10] = { x: 'a', y: 0, w: 800, h: 600 }; // not numbers: no rectangle, no window
  p.infos.oops = 'x';
  assert.equal(fromPayload(p).wins.some((w) => w.id === 10), false);
});

test('kwin units: logical pixels as they are, physical ones scaled by the output holding the centre', () => {
  const rect = { x: 100, y: 100, w: 400, h: 300 };
  const outputs = [{ x: 0, y: 0, w: 1920, h: 1080, s: 2 }];
  assert.deepEqual(toXPixels(rect, outputs, 'logical'), rect);
  assert.deepEqual(toXPixels(rect, outputs, 'physical'), { x: 200, y: 200, w: 800, h: 600 });
  assert.deepEqual(toXPixels(rect, [], 'physical'), rect); // no output known: scale 1
});

test('kwin watch: off outside a KDE Wayland session, no bus touched', () => {
  const before = process.env.XDG_CURRENT_DESKTOP;
  try {
    for (const [desktop, session] of [['GNOME', 'wayland'], ['KDE', 'x11'], ['KDE', null]]) {
      process.env.XDG_CURRENT_DESKTOP = desktop;
      const states = [];
      const logs = [];
      const watch = startKWinWatch({ session, scriptDir: '/nonexistent', onSnapshot() {}, onState: (ok) => states.push(ok), log: { log: (m) => logs.push(m), error() {} } });
      assert.deepEqual(states, [false], `${desktop} / ${session}`);
      assert.match(logs[0], /kwin watch: off/);
      watch.stop(); // a no-op, must not throw
    }
  } finally {
    if (before === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = before;
  }
});
