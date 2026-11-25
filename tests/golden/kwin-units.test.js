'use strict';

// fromPayload / applyMove xwaylandScale (linux/kwin-bridge.js) pinned before the conversion
// moves to backends/kwin/geometry.js: 'system' is identity; 'client' multiplies by the scale of
// the output holding the rect's centre; `self` stays as KWin sent it, whatever the scale.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromPayload, applyMove } = require('../../src/main/linux/kwin-bridge');

const payload = (over = {}) => ({
  v: 1,
  root: { active: 10, stacking: [10], desktop: null },
  infos: { 10: { types: [], state: [], desktop: null, pid: 5 } },
  rects: { 10: { x: 100, y: 80, w: 800, h: 600 } },
  outputs: [{ x: 0, y: 0, w: 1920, h: 1080, s: 2 }],
  self: { x: 0, y: 0, w: 1920, h: 1040 },
  ai: [],
  ...over,
});
const SELF = { x: 0, y: 0, w: 1920, h: 1040 };

test('xwaylandScale system: rects and self as they came', () => {
  const snap = fromPayload(payload(), { xwaylandScale: 'system' });
  assert.deepEqual(snap.wins, [{ id: 10, x: 100, y: 80, w: 800, h: 600, max: false }]);
  assert.deepEqual(snap.self, SELF);
});

test('xwaylandScale client: rects scaled by the output at their centre, self untouched', () => {
  const snap = fromPayload(payload(), { xwaylandScale: 'client' });
  assert.deepEqual(snap.wins, [{ id: 10, x: 200, y: 160, w: 1600, h: 1200, max: false }]);
  assert.deepEqual(snap.self, SELF);
});

test('xwaylandScale client: the output is picked by the centre, negative origins included', () => {
  const p = payload({
    rects: { 10: { x: 100, y: 100, w: 400, h: 400 } },
    outputs: [{ x: -1920, y: 0, w: 1920, h: 1080, s: 1 }, { x: 0, y: 0, w: 1920, h: 1080, s: 1.25 }],
  });
  assert.deepEqual(fromPayload(p, { xwaylandScale: 'client' }).wins, [{ id: 10, x: 125, y: 125, w: 500, h: 500, max: false }]);
});

test('xwaylandScale client with no outputs known: scale 1', () => {
  const p = payload();
  delete p.outputs;
  assert.deepEqual(fromPayload(p, { xwaylandScale: 'client' }).wins, [{ id: 10, x: 100, y: 80, w: 800, h: 600, max: false }]);
});

test('applyMove with client scaling: scaled, and no change is null', () => {
  const snap = fromPayload(payload(), { xwaylandScale: 'system' });
  const outputs = [{ x: 0, y: 0, w: 1920, h: 1080, s: 2 }];
  const moved = applyMove(snap, { id: 10, x: 50, y: 40, w: 800, h: 600 }, outputs, 'client');
  assert.deepEqual(moved.wins[0], { id: 10, x: 100, y: 80, w: 1600, h: 1200, max: false });
  assert.equal(applyMove(snap, { id: 10, x: 50, y: 40, w: 400, h: 300 }, outputs, 'client'), null);
});