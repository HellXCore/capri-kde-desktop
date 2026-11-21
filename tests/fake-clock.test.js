'use strict';

// The hand-moved clock (tests/fakes/fake-clock.js): timers fire in due order inside advance(),
// each at its own time; a callback may schedule more; clearTimeout cancels; nothing fires early.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClock } = require('./fakes/fake-clock');

test('clock: advance fires timers in due order, at their own time', () => {
  const c = createFakeClock();
  const fired = [];
  c.setTimeout(() => fired.push(['c', c.now()]), 30);
  c.setTimeout(() => fired.push(['a', c.now()]), 10);
  c.setTimeout(() => fired.push(['b', c.now()]), 20);
  c.advance(30);
  assert.deepEqual(fired, [['a', 10], ['b', 20], ['c', 30]]);
  assert.equal(c.now(), 30);
  assert.equal(c.pending, 0);
});

test('clock: only what is due fires; the rest waits for the next advance', () => {
  const c = createFakeClock();
  const fired = [];
  c.setTimeout(() => fired.push('soon'), 5);
  c.setTimeout(() => fired.push('later'), 50);
  c.advance(10);
  assert.deepEqual(fired, ['soon']);
  assert.equal(c.pending, 1);
  c.advance(40);
  assert.deepEqual(fired, ['soon', 'later']);
  assert.equal(c.pending, 0);
});

test('clock: the same deadline fires in the order scheduled', () => {
  const c = createFakeClock();
  const fired = [];
  c.setTimeout(() => fired.push(1), 10);
  c.setTimeout(() => fired.push(2), 10);
  c.advance(10);
  assert.deepEqual(fired, [1, 2]);
});

test('clock: a callback may schedule more timers, inside and past the same advance', () => {
  const c = createFakeClock();
  const fired = [];
  c.setTimeout(() => {
    fired.push(['first', c.now()]);
    c.setTimeout(() => fired.push(['second', c.now()]), 5);
    c.setTimeout(() => fired.push(['far', c.now()]), 100);
  }, 10);
  c.advance(20);
  assert.deepEqual(fired, [['first', 10], ['second', 15]]);
  assert.equal(c.pending, 1); // due at 110: beyond this advance
  c.advance(90);
  assert.deepEqual(fired.at(-1), ['far', 110]);
});

test('clock: clearTimeout cancels; twice and unknown handles are harmless', () => {
  const c = createFakeClock();
  const fired = [];
  const h = c.setTimeout(() => fired.push('x'), 10);
  c.clearTimeout(h);
  c.clearTimeout(h);
  c.clearTimeout(999);
  c.advance(100);
  assert.deepEqual(fired, []);
  assert.equal(c.pending, 0);
});

test('clock: zero and negative delays are due at once; now() starts where told', () => {
  const c = createFakeClock(1000);
  const fired = [];
  c.setTimeout(() => fired.push(c.now()), 0);
  c.setTimeout(() => fired.push(c.now()), -5);
  c.advance(0);
  assert.deepEqual(fired, [1000, 1000]);
  assert.equal(c.now(), 1000);
});

test('clock: time never runs backwards', () => {
  const c = createFakeClock(50);
  assert.throws(() => c.advance(-1), RangeError);
  assert.equal(c.now(), 50);
});