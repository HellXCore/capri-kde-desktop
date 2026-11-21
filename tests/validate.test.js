'use strict';

// core/validate.js: the schema kit. A check returns the value normalised or throws a
// ValidationError whose path names the exact field (`rects[2].w`). Strings are trimmed and cut,
// numbers are never clamped, objects refuse undeclared keys unless told otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const { v, ValidationError } = require('../src/main/core/validate');

// The error a check throws for `value`; fails the test when the value slips through.
const rejection = (check, value) => {
  try {
    check(value);
  } catch (err) {
    assert.ok(err instanceof ValidationError, `not a ValidationError: ${err}`);
    return err;
  }
  assert.fail(`expected ${JSON.stringify(value)} to be refused`);
};

test('str: trimmed, then cut to max; non-strings refused', () => {
  assert.equal(v.str()('  hi  '), 'hi');
  assert.equal(v.str()(''), '');
  assert.equal(v.str({ max: 5 })('  truncate me  '), 'trunc');
  assert.equal(v.str({ max: 5 })('abc'), 'abc');
  assert.equal(v.str({ max: 3 })('  ab  '), 'ab'); // trim first, then cut
  for (const bad of [1, true, null, undefined, {}, ['x']]) {
    assert.equal(rejection(v.str(), bad).path, '');
  }
});

test('num: finite and in range, never clamped', () => {
  assert.equal(v.num()(3.5), 3.5);
  assert.equal(v.num()(-2), -2);
  assert.equal(v.num(0, 1)(0), 0);
  assert.equal(v.num(0, 1)(1), 1);
  assert.match(rejection(v.num(0, 1), 1.01).message, /out of range/);
  rejection(v.num(0, 1), -0.01);
  for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined, true]) rejection(v.num(), bad);
});

test('int: integers only, the same range rules as num', () => {
  assert.equal(v.int()(7), 7);
  assert.equal(v.int(1)(1), 1);
  for (const bad of [7.5, NaN, Infinity, '7', null]) rejection(v.int(), bad);
  rejection(v.int(0, 10), 11);
  rejection(v.int(1), 0);
});

test('bool: booleans only, no truthiness', () => {
  assert.equal(v.bool()(true), true);
  assert.equal(v.bool()(false), false);
  for (const bad of [0, 1, 'true', '', null, undefined]) rejection(v.bool(), bad);
});

test('oneOf: membership by identity, no coercion', () => {
  const check = v.oneOf(['play', 'pause', 'next']);
  assert.equal(check('pause'), 'pause');
  assert.match(rejection(check, 'stop').message, /play, pause, next/);
  rejection(check, 'Play');
  assert.equal(v.oneOf([1, 2])(2), 2);
  rejection(v.oneOf([1, 2]), '1');
  assert.equal(v.oneOf([true])(true), true);
});

test('opt: absent stays absent, present goes through the inner check', () => {
  const check = v.opt(v.num(0, 1));
  assert.equal(check(undefined), undefined);
  assert.equal(check(0.5), 0.5);
  rejection(check, null); // present, and not a number
  rejection(check, 2);
});

test('obj: declared keys checked; a missing required key fails at its own path', () => {
  const check = v.obj({ name: v.str(), volume: v.num(0, 1), tag: v.opt(v.str()) });
  assert.deepEqual(check({ name: ' Capri ', volume: 0.7 }), { name: 'Capri', volume: 0.7 });
  assert.deepEqual(check({ name: 'x', volume: 0, tag: ' hi ' }), { name: 'x', volume: 0, tag: 'hi' });
  assert.equal(rejection(check, { volume: 0.5 }).path, 'name');
  assert.equal(rejection(check, { name: 'x', volume: 9 }).path, 'volume');
  for (const bad of [null, [], 'x', 3, undefined]) assert.equal(rejection(check, bad).path, '');
});

test('obj: undeclared keys are an error by default, dropped with strict:false', () => {
  const shape = { a: v.num() };
  const err = rejection(v.obj(shape), { a: 1, b: 2 });
  assert.equal(err.path, 'b');
  assert.match(err.message, /unknown key/);
  assert.deepEqual(v.obj(shape, { strict: false })({ a: 1, b: 2 }), { a: 1 });
  // falsy values are values: kept, not mistaken for absent
  assert.deepEqual(v.obj({ a: v.num(), ok: v.bool() }, { strict: false })({ a: 0, ok: false, junk: 1 }), { a: 0, ok: false });
});

test('obj: Object.prototype names are ordinary unknown keys, never inherited values', () => {
  const check = v.obj({ a: v.num() });
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const input = JSON.parse(`{"a":1,${JSON.stringify(key)}:{"polluted":true}}`);
    assert.equal(rejection(check, input).path, key);
    assert.deepEqual(v.obj({ a: v.num() }, { strict: false })(input), { a: 1 });
  }
  assert.equal({}.polluted, undefined);
  // a value inherited from the prototype chain was not sent: the key counts as absent
  assert.equal(rejection(check, Object.create({ a: 5 })).path, 'a');
});

test('arr: every item checked, length bounded, non-arrays refused', () => {
  const check = v.arr(v.int(0, 9), { max: 3 });
  assert.deepEqual(check([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(check([]), []);
  assert.match(rejection(check, [1, 2, 3, 4]).message, /at most 3/);
  assert.equal(rejection(check, [1, 'x']).path, '[1]');
  for (const bad of [{}, 'ab', null, undefined]) rejection(check, bad);
});

test('paths: nested objects and arrays name the exact field', () => {
  const rect = v.obj({ x: v.num(), y: v.num(), w: v.num(1), h: v.num(1) });
  const check = v.obj({ rects: v.arr(rect), label: v.opt(v.str()) });
  const good = { rects: [{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 2, h: 2 }, { x: 9, y: 9, w: 4, h: 4 }] };
  assert.deepEqual(check(good), good);
  const bad = { rects: [...good.rects.slice(0, 2), { x: 9, y: 9, w: 0, h: 4 }] };
  const err = rejection(check, bad);
  assert.equal(err.path, 'rects[2].w');
  assert.match(err.message, /^rects\[2\]\.w: /);
  assert.equal(rejection(check, { rects: [good.rects[0], 7] }).path, 'rects[1]');
  assert.equal(rejection(check, { rects: [[]] }).path, 'rects[0]');
  assert.equal(rejection(check, { rects: good.rects, label: 3 }).path, 'label');
  assert.equal(rejection(check, {}).path, 'rects');
  assert.equal(rejection(v.arr(v.arr(v.int())), [[1], [2, 'x']]).path, '[1][1]');
});

test('normalisation never touches the input', () => {
  const input = { name: '  Capri  ', rects: [{ x: 0, y: 0, w: 1, h: 1 }] };
  const before = JSON.parse(JSON.stringify(input));
  const check = v.obj({
    name: v.str({ max: 5 }),
    rects: v.arr(v.obj({ x: v.num(), y: v.num(), w: v.num(), h: v.num() })),
  });
  const out = check(input);
  assert.deepEqual(input, before);
  assert.equal(out.name, 'Capri');
  assert.notEqual(out.rects, input.rects);
  assert.notEqual(out.rects[0], input.rects[0]);
});

test('ValidationError: an Error with a path; the root path is empty', () => {
  const err = rejection(v.num(), 'x');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ValidationError');
  assert.equal(err.path, '');
  assert.equal(err.message, 'expected a finite number');
});

test('composition: a whole envelope-shaped message in one check', () => {
  const check = v.obj({
    v: v.oneOf([1]),
    kind: v.oneOf(['evt', 'cmd']),
    type: v.str({ max: 40 }),
    payload: v.opt(v.obj({ on: v.bool() }, { strict: false })),
  });
  assert.deepEqual(check({ v: 1, kind: 'cmd', type: 'overlay.focus', payload: { on: true } }),
    { v: 1, kind: 'cmd', type: 'overlay.focus', payload: { on: true } });
  assert.deepEqual(check({ v: 1, kind: 'evt', type: 'beat' }), { v: 1, kind: 'evt', type: 'beat' });
  assert.equal(rejection(check, { v: 2, kind: 'evt', type: 'beat' }).path, 'v');
  assert.equal(rejection(check, { v: 1, kind: 'evt', type: 'beat', payload: { on: 'yes' } }).path, 'payload.on');
});