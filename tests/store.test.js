'use strict';

// core/store.js: slices, selectors, sync delivery in subscription order,
// deep/shallow equality, error isolation, safe list mutation during notify.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/main/core/store');

test('get() returns the initial state', () => {
  const store = createStore({ cfg: { volume: 0.5 }, ui: { open: false } });
  assert.deepEqual(store.get(), { cfg: { volume: 0.5 }, ui: { open: false } });
});

test('update() shallow-merges a slice', () => {
  const store = createStore({ cfg: { volume: 0.5, muted: false } });
  store.update('cfg', { volume: 0.7 });
  assert.deepEqual(store.get().cfg, { volume: 0.7, muted: false });
});

test('update() on unknown slice throws', () => {
  const store = createStore({ a: {} });
  assert.throws(() => store.update('nope', {}), /unknown slice "nope"/);
});

test('update() with non-object patch throws', () => {
  const store = createStore({ a: {} });
  assert.throws(() => store.update('a', null), /patch must be an object/);
  assert.throws(() => store.update('a', 'x'), /patch must be an object/);
});

test('update() with no actual changes does not notify', () => {
  const store = createStore({ a: { x: 1 } });
  let calls = 0;
  store.subscribe((s) => s.a.x, () => { calls++; });
  store.update('a', { x: 1 });
  assert.equal(calls, 0);
});

test('subscribe() fires only when the selected value changes (Object.is)', () => {
  const store = createStore({ a: { x: 1 }, b: { y: 1 } });
  const seen = [];
  store.subscribe((s) => s.a.x, (v) => seen.push(v));
  store.update('b', { y: 2 }); // unrelated slice
  store.update('a', { x: 1 }); // same value
  store.update('a', { x: 2 }); // changed
  store.update('a', { x: 2 }); // same again
  assert.deepEqual(seen, [2]);
});

test('subscribe() with custom deep equals suppresses structurally-equal updates', () => {
  const store = createStore({ data: { items: [1, 2, 3] } });
  const seen = [];
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  store.subscribe((s) => s.data.items, (v) => seen.push([...v]), { equals: deepEq });
  store.update('data', { items: [1, 2, 3] }); // new array, same contents
  assert.deepEqual(seen, []);
  store.update('data', { items: [1, 2, 3, 4] });
  assert.deepEqual(seen, [[1, 2, 3, 4]]);
});

test('subscribers are notified in subscription order', () => {
  const store = createStore({ a: { x: 0 } });
  const order = [];
  store.subscribe((s) => s.a.x, () => order.push('first'));
  store.subscribe((s) => s.a.x, () => order.push('second'));
  store.subscribe((s) => s.a.x, () => order.push('third'));
  store.update('a', { x: 1 });
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('delivery is synchronous', () => {
  const store = createStore({ a: { x: 0 } });
  let seen = null;
  store.subscribe((s) => s.a.x, (v) => { seen = v; });
  store.update('a', { x: 5 });
  assert.equal(seen, 5);
});

test('a throwing subscriber is logged and does not break others', () => {
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  const store = createStore({ a: { x: 0 } }, { log });
  const seen = [];
  store.subscribe((s) => s.a.x, () => { throw new Error('boom'); });
  store.subscribe((s) => s.a.x, (v) => seen.push(v));
  store.update('a', { x: 1 });
  assert.deepEqual(seen, [1]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /subscriber threw: boom/);
});

test('a throwing selector is logged and does not break other subscribers', () => {
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  const store = createStore({ a: { x: 0 } }, { log });
  const seen = [];
  store.subscribe((s) => { if (s.a.x > 0) throw new Error('bad selector'); return s.a.x; }, () => {});
  store.subscribe((s) => s.a.x, (v) => seen.push(v));
  store.update('a', { x: 1 });
  assert.deepEqual(seen, [1]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /selector threw: bad selector/);
});

test('without a log sink, throwing subscribers are still isolated', () => {
  const store = createStore({ a: { x: 0 } });
  const seen = [];
  store.subscribe((s) => s.a.x, () => { throw new Error('boom'); });
  store.subscribe((s) => s.a.x, (v) => seen.push(v));
  assert.doesNotThrow(() => store.update('a', { x: 1 }));
  assert.deepEqual(seen, [1]);
});

test('unsubscribe stops delivery', () => {
  const store = createStore({ a: { x: 0 } });
  const seen = [];
  const off = store.subscribe((s) => s.a.x, (v) => seen.push(v));
  store.update('a', { x: 1 });
  off();
  store.update('a', { x: 2 });
  assert.deepEqual(seen, [1]);
});

test('unsubscribe is idempotent', () => {
  const store = createStore({ a: { x: 0 } });
  const off = store.subscribe((s) => s.a.x, () => {});
  off();
  assert.doesNotThrow(() => off());
});

test('subscribing inside a callback does not fire the new subscriber for this update', () => {
  const store = createStore({ a: { x: 0 } });
  const seen = [];
  store.subscribe((s) => s.a.x, () => {
    store.subscribe((s2) => s2.a.x, (v) => seen.push('late:' + v));
  });
  store.subscribe((s) => s.a.x, (v) => seen.push('main:' + v));
  store.update('a', { x: 1 });
  assert.deepEqual(seen, ['main:1']);
  store.update('a', { x: 2 });
  // order follows subscription: the late subscriber was appended after 'main'
  assert.deepEqual(seen, ['main:1', 'main:2', 'late:2']);
});

test('unsubscribing inside a callback does not skip later subscribers', () => {
  const store = createStore({ a: { x: 0 } });
  const seen = [];
  let offSecond;
  store.subscribe((s) => s.a.x, () => { offSecond(); });
  offSecond = store.subscribe((s) => s.a.x, () => seen.push('second'));
  store.subscribe((s) => s.a.x, () => seen.push('third'));
  store.update('a', { x: 1 });
  assert.deepEqual(seen, ['third']);
});

test('createStore with non-object initial throws', () => {
  assert.throws(() => createStore(null), /initial state must be an object/);
  assert.throws(() => createStore(42), /initial state must be an object/);
  assert.throws(() => createStore('x'), /initial state must be an object/);
});

test('subscribe() validates arguments', () => {
  const store = createStore({ a: {} });
  assert.throws(() => store.subscribe(null, () => {}), /selector must be a function/);
  assert.throws(() => store.subscribe(() => 1, null), /cb must be a function/);
});

test('subscribe({ immediate: true }) fires with the current value', () => {
  const store = createStore({ a: { x: 7 } });
  const seen = [];
  store.subscribe((s) => s.a.x, (v) => seen.push(v), { immediate: true });
  assert.deepEqual(seen, [7]);
});

test('subscribe({ immediate: true }) with a throwing cb is isolated', () => {
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  const store = createStore({ a: { x: 1 } }, { log });
  assert.doesNotThrow(() => {
    store.subscribe((s) => s.a.x, () => { throw new Error('init boom'); }, { immediate: true });
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /subscribe\(immediate\) threw: init boom/);
});