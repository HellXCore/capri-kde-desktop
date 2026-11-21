'use strict';

// The toggle region (linux/wayland-toggle.js) pinned as sequences on a clock moved by hand:
// taking input is immediate, giving it back waits leaveMs, re-entering within the grace period
// cancels the give-back without a flip. Each flip is a compositor frame — the count matters.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToggleRegion, LEAVE_MS, PADDING } = require('../../src/main/platform/input/toggle');

function fakeTimers() {
  let now = 0;
  let id = 0;
  const due = new Map();
  return {
    setTimeout: (fn, ms) => { due.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (h) => due.delete(h),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        due.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
    get pending() { return due.size; },
  };
}

function fakeOverlay() {
  const o = {
    told: { ignore: [], invalidates: 0 },
    dead: false,
    isDestroyed: () => o.dead,
    setIgnoreMouseEvents: (v) => o.told.ignore.push(v),
    webContents: { invalidate: () => { o.told.invalidates += 1; } },
  };
  return o;
}

const RECT = [{ x: 100, y: 100, width: 50, height: 50 }];
const make = (overlay, timers) => createToggleRegion({ overlay, timers, log: { log() {}, warn() {} }, trace: false });

test('enter is immediate, leave waits leaveMs', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  assert.deepEqual(o.told.ignore, [true]); // click-through from the start
  assert.deepEqual(r.stats(), { pointers: 0, flips: 1, rects: 0 });
  r.set(RECT);
  r.pointer({ x: 110, y: 110 });
  assert.deepEqual(o.told.ignore, [true, false]); // taken at once, no timer
  r.pointer({ x: 300, y: 300 });
  t.advance(LEAVE_MS - 1);
  assert.deepEqual(o.told.ignore, [true, false]); // still hers
  t.advance(1);
  assert.deepEqual(o.told.ignore, [true, false, true]);
  assert.equal(r.stats().flips, 3);
  r.close();
});

test('re-enter within the grace period: the give-back is cancelled, no flip', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.set(RECT);
  r.pointer({ x: 110, y: 110 });
  r.pointer({ x: 300, y: 300 });
  t.advance(100);
  r.pointer({ x: 105, y: 105 });
  assert.equal(t.pending, 0);
  assert.deepEqual(o.told.ignore, [true, false]); // same value: not said again
  assert.equal(r.stats().flips, 2);
  t.advance(1000);
  assert.deepEqual(o.told.ignore, [true, false]);
  r.close();
});

test('the padding is hers: 6 px around the rect counts, 7 does not', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.set(RECT);
  r.pointer({ x: 100 - PADDING, y: 125 });
  assert.deepEqual(o.told.ignore, [true, false]);
  r.pointer({ x: 100 - PADDING - 1, y: 125 });
  t.advance(LEAVE_MS);
  assert.deepEqual(o.told.ignore, [true, false, true]);
  r.pointer({ x: 150 + PADDING, y: 150 + PADDING }); // the far corner, padding included
  assert.deepEqual(o.told.ignore, [true, false, true, false]);
  r.close();
});

test('rects appearing under a still pointer take it at once; empty rects are dropped', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.pointer({ x: 110, y: 110 });
  assert.deepEqual(o.told.ignore, [true]); // nothing of hers there yet
  r.set([null, { x: 0, y: 0, width: 0, height: 10 }, ...RECT]);
  assert.equal(r.stats().rects, 1);
  assert.deepEqual(o.told.ignore, [true, false]);
  r.close();
});

test('reapply says it again without a flip', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.reapply();
  assert.deepEqual(o.told.ignore, [true, true]);
  assert.equal(r.stats().flips, 1);
  assert.equal(o.told.invalidates, 2);
  r.close();
});

test('close cancels a pending give-back', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.set(RECT);
  r.pointer({ x: 110, y: 110 });
  r.pointer({ x: 300, y: 300 });
  r.close();
  t.advance(1000);
  assert.deepEqual(o.told.ignore, [true, false]);
  assert.equal(t.pending, 0);
});

test('invalid pointer positions are not heard', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.pointer(null);
  r.pointer({ x: NaN, y: 0 });
  r.pointer({ x: 1, y: undefined });
  assert.equal(r.stats().pointers, 0);
  assert.deepEqual(o.told.ignore, [true]);
  r.close();
});

test('a destroyed window is told nothing', () => {
  const t = fakeTimers();
  const o = fakeOverlay();
  const r = make(o, t);
  r.set(RECT);
  o.dead = true;
  r.pointer({ x: 110, y: 110 });
  assert.deepEqual(o.told.ignore, [true]);
  assert.equal(r.stats().flips, 1);
  r.close();
});