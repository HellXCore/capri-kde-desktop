'use strict';

// core/supervisor.js: the state table on a clock moved by hand. Every wait it takes is one the test
// can see (clock.pending), and every attempt's outcome is the test's to choose.

const test = require('node:test');
const assert = require('node:assert/strict');
const { supervise, DEFAULT_POLICY } = require('../src/main/core/supervisor');
const { createFakeClock } = require('./fakes/fake-clock');

const POLICY = { backoffMs: [10, 20, 40], stableAfterMs: 1000, startTimeoutMs: 50 };

// A start settles when the test says so; this lets the promise's own callbacks run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function recorder() {
  const lines = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (msg) => lines.push([level, msg]);
  return { log, lines };
}

// A supervisor around a component the test drives: `starts` holds one { resolve, reject } per
// attempt, `stopped` what was torn down, `seen` the states it went through, `lines` what it logged.
function make(over = {}) {
  const clock = createFakeClock();
  const { log, lines } = recorder();
  const starts = [];
  const stopped = [];
  const sup = supervise({
    name: 'agent',
    start: () => new Promise((resolve, reject) => starts.push({ resolve, reject })),
    stop: async (h) => { stopped.push(h); },
    policy: POLICY,
    clock,
    log,
    ...over,
  });
  const seen = [];
  sup.on((s, why) => seen.push(why === undefined ? s : `${s} (${why})`));
  return { sup, clock, starts, stopped, seen, lines };
}

const settle = async (m, handle) => { m.starts.at(-1).resolve(handle); await flush(); };
const fail = async (m, why) => { m.starts.at(-1).reject(new Error(why)); await flush(); };

test('the policy written down is the default', () => {
  assert.deepEqual(DEFAULT_POLICY, {
    backoffMs: [250, 1000, 4000, 15000, 60000], stableAfterMs: 60000, startTimeoutMs: 8000,
  });
  assert.ok(Object.isFrozen(DEFAULT_POLICY), 'the shared default must not be writable');
});

test('a name, start, stop and a clock are required', () => {
  const { log } = recorder();
  const base = { name: 'agent', start: async () => null, stop: async () => {}, clock: createFakeClock(), log };
  for (const bad of [{ name: '' }, { name: '  ' }, { name: 42 }, { start: null }, { stop: 'no' }, { clock: null }, { clock: {} }]) {
    assert.throws(() => supervise({ ...base, ...bad }), TypeError, JSON.stringify(bad));
  }
});

test('idle → starting → ready: the deadline is dropped, the handle is kept for the stop', async () => {
  const m = make();
  assert.equal(m.sup.state(), 'idle');
  m.sup.start();
  assert.equal(m.sup.state(), 'starting');
  assert.equal(m.starts.length, 1);
  assert.equal(m.clock.pending, 1); // the start deadline
  await settle(m, 'h1');
  assert.equal(m.sup.state(), 'ready');
  assert.deepEqual(m.seen, ['starting', 'ready']);
  m.clock.advance(POLICY.startTimeoutMs + 1);
  assert.equal(m.sup.state(), 'ready'); // only the stability window is left
  assert.equal(m.clock.pending, 1);
  await m.sup.stop();
  assert.equal(m.sup.state(), 'stopped');
  assert.deepEqual(m.stopped, ['h1']);
  assert.equal(m.clock.pending, 0);
});

test('start() said again is the same one attempt, wherever it is said', async () => {
  const m = make();
  m.sup.start();
  m.sup.start();
  assert.equal(m.starts.length, 1);
  await settle(m, 'h');
  m.sup.start();
  assert.equal(m.starts.length, 1);
  m.sup.failed(new Error('gone'));
  assert.equal(m.sup.state(), 'degraded');
  m.sup.start(); // a retry is scheduled already: this must not jump the queue
  assert.equal(m.starts.length, 1);
  m.clock.advance(10);
  assert.equal(m.starts.length, 2);
});

test('a start that fails comes back after the first backoff step, then the second', async () => {
  const m = make();
  m.sup.start();
  await fail(m, 'no bus');
  assert.equal(m.sup.state(), 'degraded');
  assert.equal(m.clock.pending, 1);
  m.clock.advance(9);
  assert.equal(m.starts.length, 1);
  m.clock.advance(1);
  assert.equal(m.starts.length, 2);
  assert.equal(m.sup.state(), 'starting');
  await fail(m, 'still no bus');
  m.clock.advance(19);
  assert.equal(m.starts.length, 2);
  m.clock.advance(1);
  assert.equal(m.starts.length, 3);
  assert.deepEqual(m.seen, ['starting', 'degraded (no bus)', 'starting', 'degraded (still no bus)', 'starting']);
});

test('the last backoff step repeats: it never gives up', async () => {
  const m = make();
  m.sup.start();
  let n = 1;
  for (const wait of [10, 20, 40, 40, 40]) {
    await fail(m, 'still down');
    m.clock.advance(wait - 1);
    assert.equal(m.starts.length, n, `no early retry at ${wait - 1} ms`);
    m.clock.advance(1);
    n += 1;
    assert.equal(m.starts.length, n);
    assert.equal(m.sup.state(), 'starting');
  }
});

test('a start that never comes up times out and is retried', async () => {
  const m = make();
  m.sup.start();
  m.clock.advance(POLICY.startTimeoutMs - 1);
  assert.equal(m.sup.state(), 'starting');
  m.clock.advance(1);
  assert.equal(m.sup.state(), 'degraded');
  assert.match(m.seen.at(-1), /timed out after 50 ms/);
  m.clock.advance(10);
  assert.equal(m.starts.length, 2);
  await settle(m, 'h');
  assert.equal(m.sup.state(), 'ready');
});

test('an attempt that arrives after its timeout is stopped, not adopted', async () => {
  const m = make();
  m.sup.start();
  m.clock.advance(POLICY.startTimeoutMs);
  await settle(m, 'late');
  assert.deepEqual(m.stopped, ['late']);
  assert.equal(m.sup.state(), 'degraded');
  assert.deepEqual(m.seen, ['starting', 'degraded (start timed out after 50 ms)']);
  m.clock.advance(10);
  await settle(m, 'h2');
  assert.equal(m.sup.state(), 'ready');
  assert.deepEqual(m.stopped, ['late']);
});

test('a failure of an attempt already given up on changes nothing', async () => {
  const m = make();
  m.sup.start();
  m.clock.advance(POLICY.startTimeoutMs);
  await fail(m, 'late failure');
  assert.deepEqual(m.seen, ['starting', 'degraded (start timed out after 50 ms)']);
  assert.deepEqual(m.stopped, []);
  m.clock.advance(10);
  assert.equal(m.starts.length, 2);
});

test('healthy(): it says it is up before start() has resolved', async () => {
  const m = make();
  m.sup.start();
  m.sup.healthy();
  assert.equal(m.sup.state(), 'ready');
  m.clock.advance(POLICY.startTimeoutMs + 1);
  assert.equal(m.sup.state(), 'ready'); // the start deadline went when it came up
  await settle(m, 'h1');
  assert.deepEqual(m.seen, ['starting', 'ready']); // ready said once
  await m.sup.stop();
  assert.deepEqual(m.stopped, ['h1']); // the handle that arrived later is still the one to stop
});

test('stableAfterMs in ready forgets the failures; healthy() does not postpone it', async () => {
  const m = make();
  m.sup.start();
  await fail(m, 'one');
  m.clock.advance(10);
  await settle(m, 'h');
  m.clock.advance(POLICY.stableAfterMs - 5);
  m.sup.healthy(); // a beat: the window still ends when it was going to
  m.clock.advance(5);
  m.sup.failed(new Error('two'));
  m.clock.advance(9);
  assert.equal(m.starts.length, 2);
  m.clock.advance(1);
  assert.equal(m.starts.length, 3); // the first step again, not the second
});

test('a failure before the stability window is over keeps counting', async () => {
  const m = make();
  m.sup.start();
  await fail(m, 'one');
  m.clock.advance(10);
  await settle(m, 'h');
  m.clock.advance(POLICY.stableAfterMs - 1);
  m.sup.failed(new Error('two'));
  m.clock.advance(19);
  assert.equal(m.starts.length, 2);
  m.clock.advance(1);
  assert.equal(m.starts.length, 3); // the second step
});

test('failed() in ready stops the component and starts it again', async () => {
  const m = make();
  m.sup.start();
  await settle(m, 'h1');
  m.sup.failed(new Error('beat missing'));
  assert.equal(m.sup.state(), 'degraded');
  assert.deepEqual(m.stopped, ['h1']);
  m.clock.advance(10);
  assert.equal(m.sup.state(), 'starting');
  await settle(m, 'h2');
  assert.deepEqual(m.seen, ['starting', 'ready', 'degraded (beat missing)', 'starting', 'ready']);
  assert.equal(m.clock.pending, 1);
});

test('failed() while it is still starting is a start failure', async () => {
  const m = make();
  m.sup.start();
  m.sup.failed(new Error('transport closed'));
  assert.equal(m.sup.state(), 'degraded');
  assert.equal(m.clock.pending, 1); // the deadline dropped, the retry armed
  await settle(m, 'orphan');
  assert.deepEqual(m.stopped, ['orphan']);
  m.clock.advance(10);
  assert.equal(m.starts.length, 2);
});

test('a late word from an instance given up on is ignored', async () => {
  const m = make();
  m.sup.start();
  await settle(m, 'h');
  m.sup.failed(new Error('gone'));
  m.sup.failed(new Error('gone again'));
  m.sup.healthy();
  assert.equal(m.sup.state(), 'degraded');
  assert.deepEqual(m.stopped, ['h']);
  assert.deepEqual(m.seen, ['starting', 'ready', 'degraded (gone)']);
  m.clock.advance(10);
  assert.equal(m.starts.length, 2);
});

test('stop() during starting leaves no timers, and the attempt that arrives is stopped', async () => {
  const m = make();
  m.sup.start();
  const stopping = m.sup.stop();
  assert.equal(m.sup.state(), 'stopped');
  assert.equal(m.clock.pending, 0);
  await stopping;
  await settle(m, 'orphan');
  assert.deepEqual(m.stopped, ['orphan']);
  assert.equal(m.sup.state(), 'stopped');
  m.clock.advance(100000);
  assert.equal(m.starts.length, 1);
  assert.equal(m.clock.pending, 0);
});

test('stop() during degraded cancels the retry', async () => {
  const m = make();
  m.sup.start();
  await fail(m, 'down');
  await m.sup.stop();
  assert.equal(m.clock.pending, 0);
  m.clock.advance(100000);
  assert.equal(m.starts.length, 1);
  assert.equal(m.sup.state(), 'stopped');
});

test('stop() is final and idempotent: nothing to stop in idle, one stop per component', async () => {
  const m = make();
  await m.sup.stop();
  assert.equal(m.sup.state(), 'stopped');
  assert.deepEqual(m.stopped, []);
  m.sup.start();
  assert.equal(m.starts.length, 0);
  const other = make({ start: async () => 'h' });
  other.sup.start();
  await flush();
  await other.sup.stop();
  await other.sup.stop();
  assert.deepEqual(other.stopped, ['h']);
  other.sup.start();
  assert.equal(other.sup.state(), 'stopped');
  assert.equal(other.clock.pending, 0);
});

test('a stop that throws is logged, and stop() still resolves', async () => {
  const m = make({ start: async () => 'h', stop: async () => { throw new Error('EBUSY'); } });
  m.sup.start();
  await flush();
  await assert.doesNotReject(m.sup.stop());
  assert.equal(m.sup.state(), 'stopped');
  assert.ok(m.lines.some(([level, msg]) => level === 'error' && /EBUSY/.test(msg)));
  assert.equal(m.clock.pending, 0);
});

test('a start that throws synchronously is a failure like any other', async () => {
  let calls = 0;
  const m = make({
    start: () => { calls += 1; if (calls === 1) throw new Error('spawn ENOENT'); return Promise.resolve('h'); },
  });
  m.sup.start();
  assert.equal(m.sup.state(), 'starting');
  await flush();
  assert.equal(m.sup.state(), 'degraded');
  assert.match(m.seen.at(-1), /spawn ENOENT/);
  m.clock.advance(10);
  await flush();
  assert.equal(m.sup.state(), 'ready');
  assert.equal(calls, 2);
});

test('listeners hear every change in order; a throwing one is logged and breaks nothing', async () => {
  const m = make({ start: async () => 'h' });
  const seen = [];
  const off = m.sup.on((s) => seen.push(`first:${s}`));
  m.sup.on(() => { throw new Error('listener boom'); });
  m.sup.on((s) => seen.push(`third:${s}`));
  m.sup.start();
  await flush();
  assert.deepEqual(seen, ['first:starting', 'third:starting', 'first:ready', 'third:ready']);
  assert.ok(m.lines.some(([level, msg]) => level === 'error' && /listener boom/.test(msg)));
  off();
  const late = [];
  m.sup.on((s) => late.push(s)); // subscribing does not replay the state it subscribes in
  assert.deepEqual(late, []);
  await m.sup.stop();
  assert.deepEqual(late, ['stopped']);
  assert.deepEqual(seen.filter((s) => s.startsWith('first:')), ['first:starting', 'first:ready']);
});

test('a listener that stops it from inside a change leaves nothing armed', async () => {
  const onStarting = make();
  onStarting.sup.on((s) => { if (s === 'starting') void onStarting.sup.stop(); });
  onStarting.sup.start();
  assert.equal(onStarting.sup.state(), 'stopped');
  assert.equal(onStarting.starts.length, 0);
  assert.equal(onStarting.clock.pending, 0);
  const onDegraded = make();
  onDegraded.sup.on((s) => { if (s === 'degraded') void onDegraded.sup.stop(); });
  onDegraded.sup.start();
  await fail(onDegraded, 'down');
  assert.equal(onDegraded.sup.state(), 'stopped');
  assert.equal(onDegraded.clock.pending, 0);
  onDegraded.clock.advance(100000);
  assert.equal(onDegraded.starts.length, 1);
});

test('every wait goes through the clock it was handed', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('a timer outside the clock'); });
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('an interval outside the clock'); });
  const m = make();
  m.sup.start();
  await fail(m, 'down');
  m.clock.advance(10);
  await settle(m, 'h');
  m.clock.advance(POLICY.stableAfterMs);
  m.sup.failed(new Error('beat gone'));
  m.clock.advance(10);
  await settle(m, 'h2');
  await m.sup.stop();
  assert.deepEqual(m.stopped, ['h', 'h2']);
  assert.equal(m.clock.pending, 0);
});