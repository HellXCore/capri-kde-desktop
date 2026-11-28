'use strict';

// The agent protocol: one envelope, one catalog, one validation path in both directions. Every type
// has a valid and a broken sample (tests/fakes/agent-messages.js), so the coverage claim is checked
// by the runner rather than asserted here. What is refused is refused as a whole, with a code the
// caller can branch on; the boundary reader counts and logs it instead of repairing it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROTO, ProtocolError, CATALOG, decode, encode, createCodec } = require('../src/main/platform/agent/protocol');
const { createLogger } = require('../src/main/core/log');
const { SAMPLES, RESULTS, CASES, REFUSED, SHAPES, RECT, DISPLAY, ENV, FRAME, FACT } = require('./fakes/agent-messages');

const TYPES = [
  'hello', 'displays', 'overlay.want', 'overlay.zones', 'overlay.focus', 'overlay.stack', 'hotkey.set', 'shutdown',
  'os.windows', 'os.launchables', 'os.launch', 'os.media', 'os.search', 'os.screenshot', 'os.terminal',
  'control.closeApps', 'observe.workArea',
  'ready', 'health', 'beat', 'frame', 'pointer', 'fact', 'overlay.actual', 'hotkey', 'log',
];

// The refusal a value earns; fails the test when it slips through.
const refusal = (raw) => {
  try {
    decode(raw);
  } catch (err) {
    assert.ok(err instanceof ProtocolError, `not a ProtocolError: ${err}`);
    assert.ok(err instanceof Error);
    return err;
  }
  assert.fail(`expected ${JSON.stringify(raw)} to be refused`);
};

const recorder = () => {
  const lines = [];
  const sink = {};
  for (const level of ['debug', 'info', 'warn', 'error']) sink[level] = (msg) => lines.push([level, msg]);
  return { sink, lines };
};

test('the catalog is the whole vocabulary, and it is frozen', () => {
  assert.equal(PROTO, 1);
  assert.equal(TYPES.length, 26);
  assert.deepEqual(Object.keys(CATALOG).sort(), [...TYPES].sort());
  assert.ok(Object.isFrozen(CATALOG));
  for (const [type, entry] of Object.entries(CATALOG)) {
    assert.ok(['cmd', 'req', 'evt'].includes(entry.kind), type);
    assert.equal(entry.dir, entry.kind === 'evt' ? 'agent-to-host' : 'host-to-agent', type);
    assert.equal(typeof entry.payload, 'function', type);
  }
});

test('every catalog type has a valid and a broken sample, every request a result', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(CATALOG).sort());
  const refused = new Set(REFUSED.map((r) => r.raw.type));
  for (const type of Object.keys(CATALOG)) assert.ok(refused.has(type), `${type} has no invalid sample`);
  const requests = Object.keys(CATALOG).filter((t) => CATALOG[t].kind === 'req');
  assert.deepEqual(Object.keys(RESULTS).sort(), requests.sort());
});

test('every message survives encode → decode → JSON unchanged', () => {
  for (const c of CASES) {
    const wire = encode(c.env);
    assert.equal(wire.v, PROTO, c.name);
    assert.deepEqual(decode(wire), wire, c.name);
    assert.deepEqual(decode(JSON.parse(JSON.stringify(wire))), wire, `${c.name} through JSON`);
    assert.deepEqual(encode(decode(wire)), wire, `${c.name} encoded again`);
  }
});

test('a broken payload of every type is refused, and the field is named', () => {
  for (const bad of REFUSED) assert.equal(refusal(bad.raw).code, bad.code, bad.name);
  assert.match(refusal({ v: 1, kind: 'cmd', type: 'overlay.focus', payload: { on: 'yes' } }).message, /^payload\.on:/);
  const frame = { ...FRAME, wins: [{ id: 7, rect: { ...RECT, h: '200' }, max: false }] };
  assert.match(refusal({ v: 1, kind: 'evt', type: 'frame', payload: frame }).message, /^payload\.wins\[0\]\.rect\.h:/);
});

test('anything that is not an object is refused as a shape', () => {
  for (const raw of SHAPES) assert.equal(refusal(raw).code, 'shape');
});

test('a version mismatch is a build error, not a negotiation', () => {
  for (const v of [2, 0, '1', null, undefined]) {
    assert.equal(refusal({ v, kind: 'evt', type: 'beat', payload: { t: 1 } }).code, 'version');
  }
  assert.equal(refusal({ kind: 'evt', type: 'beat', payload: { t: 1 } }).code, 'version');
});

test('an unknown type is refused, Object.prototype names included', () => {
  for (const type of ['nope', 'constructor', '__proto__', 'toString', '', 42, null]) {
    assert.equal(refusal({ v: 1, kind: 'evt', type, payload: {} }).code, 'unknown');
  }
});

test('the kind is the catalog\'s, and a reply only answers a request', () => {
  assert.equal(refusal({ v: 1, kind: 'cmd', type: 'beat', payload: { t: 1 } }).code, 'invalid');
  assert.equal(refusal({ v: 1, kind: 'evt', type: 'shutdown', payload: {} }).code, 'invalid');
  assert.equal(refusal({ v: 1, kind: 'res', type: 'beat', id: 1, payload: {} }).code, 'invalid');
  assert.equal(refusal({ v: 1, type: 'beat', payload: { t: 1 } }).code, 'invalid');
  assert.equal(decode({ v: 1, kind: 'res', type: 'os.media', id: 1, payload: true }).payload, true);
});

test('an extra key is refused, on the envelope and in the payload', () => {
  assert.match(refusal({ v: 1, kind: 'evt', type: 'beat', payload: { t: 1 }, extra: true }).message, /unknown key extra/);
  assert.match(refusal({ v: 1, kind: 'evt', type: 'beat', payload: { t: 1, extra: 1 } }).message, /^payload\.extra:/);
});

test('ids belong to requests and replies, and are whole numbers', () => {
  assert.equal(refusal({ v: 1, kind: 'evt', type: 'beat', id: 1, payload: { t: 1 } }).code, 'invalid');
  assert.equal(refusal({ v: 1, kind: 'cmd', type: 'shutdown', id: 1, payload: {} }).code, 'invalid');
  for (const id of [undefined, '7', 1.5, -1, null]) {
    assert.equal(refusal({ v: 1, kind: 'req', type: 'os.media', id, payload: { action: 'pause' } }).code, 'invalid');
  }
  assert.equal(decode({ v: 1, kind: 'req', type: 'os.media', id: 0, payload: { action: 'pause' } }).id, 0);
});

test('a reply carries a result or an error, never both', () => {
  const err = { code: 'not-found', msg: 'no such app' };
  const answered = decode({ v: 1, kind: 'res', type: 'os.launch', id: 1, err });
  assert.deepEqual(answered.err, err);
  assert.equal('payload' in answered, false);
  assert.equal(refusal({ v: 1, kind: 'evt', type: 'log', payload: { level: 'info', msg: 'x' }, err }).code, 'invalid');
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.launch', id: 1, payload: null, err }).code, 'invalid');
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.launch', id: 1, err: { code: 'x' } }).code, 'invalid');
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.launch', id: 1, err: { code: 'x', msg: 5 } }).code, 'invalid');
});

test('a reply carries the JSON result, whatever its shape', () => {
  const results = [null, true, 42, 'iVBORw0KGgo=', [], [1, 2, 3], { running: false }, { nested: { list: [1, null, 'x'] } }];
  for (const payload of results) {
    assert.deepEqual(decode({ v: 1, kind: 'res', type: 'os.windows', id: 1, payload }).payload, payload);
  }
  assert.equal(decode({ v: 1, kind: 'res', type: 'os.windows', id: 1 }).payload, null);
});

test('an opaque result is still bounded', () => {
  const deep = (n) => (n === 0 ? 1 : { a: deep(n - 1) });
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.windows', id: 1, payload: deep(12) }).code, 'invalid');
  assert.deepEqual(decode({ v: 1, kind: 'res', type: 'os.windows', id: 1, payload: deep(3) }).payload, deep(3));
  const long = Array.from({ length: 1025 }, (_, i) => i);
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.windows', id: 1, payload: long }).code, 'invalid');
  const wide = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i]));
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.windows', id: 1, payload: wide }).code, 'invalid');
  const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
  assert.equal(refusal({ v: 1, kind: 'res', type: 'os.screenshot', id: 1, payload: huge }).code, 'invalid');
  for (const bad of [NaN, Infinity, undefined, () => {}, 10n]) {
    assert.equal(refusal({ v: 1, kind: 'res', type: 'os.windows', id: 1, payload: { bad } }).code, 'invalid');
  }
});

test('normalisation: strings are trimmed and cut, numbers are never clamped', () => {
  const sent = encode({ kind: 'cmd', type: 'hotkey.set', payload: { id: '  stow  ', accel: 'C'.repeat(100) } });
  assert.equal(sent.payload.id, 'stow');
  assert.equal(sent.payload.accel.length, 80);
  assert.equal(refusal({ v: 1, kind: 'cmd', type: 'overlay.zones', payload: { rects: [RECT], dpr: -1 } }).code, 'invalid');
});

test('an absent payload is an empty object where the catalog allows one', () => {
  assert.deepEqual(decode({ v: 1, kind: 'cmd', type: 'shutdown' }).payload, {});
  assert.deepEqual(decode({ v: 1, kind: 'req', type: 'os.windows', id: 1 }).payload, {});
  assert.equal(refusal({ v: 1, kind: 'cmd', type: 'hello' }).code, 'invalid');
});

test('nullable fields take null and the value alike', () => {
  const hello = (xid, env) => encode({
    kind: 'cmd', type: 'hello',
    payload: { env, displays: [DISPLAY], overlay: { pid: 4242, title: 'capri-overlay', xid } },
  });
  assert.equal(decode(hello(null, ENV)).payload.overlay.xid, null);
  assert.equal(decode(hello(0x4400002, ENV)).payload.overlay.xid, 0x4400002);
  assert.equal(decode(hello(null, { ...ENV, plasma: null, ozone: 'x11' })).payload.env.plasma, null);
  const frame = encode({ kind: 'evt', type: 'frame', payload: { ...FRAME, self: null, front: { ai: [], game: null } } });
  assert.equal(decode(frame).payload.self, null);
  assert.equal(decode(frame).payload.front.game, null);
  assert.equal(decode(encode({ kind: 'evt', type: 'fact', payload: { ...FACT, plug: null } })).payload.plug, null);
});

test('decode never touches what it was handed', () => {
  const raw = Object.freeze({
    v: 1, kind: 'evt', type: 'frame',
    payload: Object.freeze({
      ...FRAME,
      front: Object.freeze({ ai: Object.freeze(['chatgpt']), game: 'Night City' }),
      wins: Object.freeze([Object.freeze({ id: 7, rect: Object.freeze({ x: 1, y: 2, w: 3, h: 4 }), max: false })]),
      self: null,
    }),
  });
  const out = decode(raw);
  assert.notEqual(out.payload, raw.payload);
  assert.notEqual(out.payload.wins[0], raw.payload.wins[0]);
  assert.notEqual(out.payload.front.ai, raw.payload.front.ai);
  assert.equal(out.payload.rev, FRAME.rev);
});

test('the boundary reader passes what is valid and counts what it refuses', () => {
  const { sink, lines } = recorder();
  const codec = createCodec({ log: createLogger({ scope: 'agent-protocol', sink }) });
  const wire = encode({ kind: 'evt', type: 'beat', payload: { t: 1 } });
  assert.deepEqual(codec.read(wire), wire);
  assert.equal(codec.invalid(), 0);
  assert.deepEqual(lines, []);
  assert.equal(codec.read({ v: 2, kind: 'evt', type: 'beat', payload: { t: 1 } }), null);
  assert.equal(codec.read({ v: 1, kind: 'evt', type: 'nope', payload: {} }), null);
  assert.equal(codec.invalid(), 2);
  assert.equal(lines.length, 2);
  assert.match(lines[0][1], /^\[agent-protocol\] protocol\.invalid #1 \(version\):/);
  assert.match(lines[1][1], /protocol\.invalid #2 \(unknown\)/);
  assert.deepEqual(codec.read(wire), wire); // still serving after a refusal
  assert.equal(codec.invalid(), 2);
});

test('the reader\'s own encode throws: a message we build is our bug, not the wire\'s', () => {
  const { sink, lines } = recorder();
  const codec = createCodec({ log: createLogger({ scope: 'agent-protocol', sink }) });
  assert.throws(() => codec.encode({ kind: 'cmd', type: 'shutdown', payload: { extra: 1 } }), ProtocolError);
  assert.equal(codec.invalid(), 0);
  assert.deepEqual(lines, []);
});

test('two readers count apart: nothing is kept between them', () => {
  const one = createCodec({ log: createLogger({ scope: 'a', sink: recorder().sink }) });
  const two = createCodec({ log: createLogger({ scope: 'b', sink: recorder().sink }) });
  one.read(null);
  assert.equal(one.invalid(), 1);
  assert.equal(two.invalid(), 0);
});
