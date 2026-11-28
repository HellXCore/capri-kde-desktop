'use strict';

// The utility-process glue, on a stand-in child: what the transport sends goes out as postMessage,
// both spellings of the message event are heard, an exit ends the channel once, and closing or
// killing it kills the process. No Electron here — the fork is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUtilityLauncher } = require('../src/main/app/agent-launcher');
const { encode } = require('../src/main/platform/agent/protocol');

function fakeChild() {
  const child = new EventEmitter();
  child.posted = [];
  child.killed = 0;
  child.postMessage = (m) => child.posted.push(m);
  child.kill = () => { child.killed += 1; return true; };
  return child;
}

const beat = (t) => encode({ kind: 'evt', type: 'beat', payload: { t } });

async function make(env = { PATH: '/usr/bin' }) {
  const child = fakeChild();
  const calls = [];
  const launcher = createUtilityLauncher({ fork: (entry, options) => { calls.push([entry, options]); return child; }, env });
  const handle = await launcher.start('/app/agent-main.js');
  return { child, calls, handle, ...handle };
}

test('the entry and a clean environment are handed to the fork', async () => {
  const m = await make({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(m.calls[0][0], '/app/agent-main.js');
  assert.deepEqual(m.calls[0][1].env, { PATH: '/usr/bin' });
  assert.equal(m.calls[0][1].stdio, 'pipe');
});

test('what the transport is told goes out as postMessage', async () => {
  const m = await make();
  m.transport.send(beat(1));
  assert.deepEqual(m.child.posted, [beat(1)]);
  m.transport.close();
});

test('both spellings of the message event are heard', async () => {
  const m = await make();
  const seen = [];
  m.transport.onMessage((msg) => seen.push(msg));
  m.child.emit('message', { data: beat(1) });
  m.child.emit('message', beat(2));
  assert.deepEqual(seen.map((x) => x.payload.t), [1, 2]);
  m.transport.close();
});

test('an exit ends the channel once; a close after it does nothing more', async () => {
  const m = await make();
  const reasons = [];
  m.transport.onClose((r) => reasons.push(r));
  m.child.emit('exit', 0);
  m.child.emit('exit', 0);
  assert.deepEqual(reasons, ['exit 0']);
  m.transport.close(); // the channel is already over: no second ending, nothing left to kill
  assert.equal(m.child.killed, 0);
  m.handle.kill();
  assert.equal(m.child.killed, 1);
});

test('closing a live channel kills the process; kill() is the launcher\'s own switch', async () => {
  const m = await make();
  const reasons = [];
  m.transport.onClose((r) => reasons.push(r));
  m.transport.close();
  m.transport.close();
  assert.deepEqual(reasons, ['closed']);
  assert.equal(m.child.killed, 1); // the glue's disconnect() is child.kill()
  m.handle.kill();
  assert.equal(m.child.killed, 2);
});

test('a send that cannot go out ends the channel with the reason', async () => {
  const m = await make();
  const reasons = [];
  m.transport.onClose((r) => reasons.push(r));
  m.child.postMessage = () => { throw new Error('the process is gone'); };
  m.transport.send(beat(1));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /send failed/);
});