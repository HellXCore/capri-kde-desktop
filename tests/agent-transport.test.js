'use strict';

// The three pipes themselves: what each does with the channel it is handed, and what it says when
// that channel goes away. The traffic they carry is the contract's business
// (tests/contract/agent-transport.test.js); here it is the plumbing, plus the two things only a real
// process can show — a kill and a disconnect.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { encode } = require('../src/main/platform/agent/protocol');
const { memoryPair } = require('../src/main/platform/agent/transport/memory');
const { parentPortTransport } = require('../src/main/platform/agent/transport/parent-port');
const { nodeIpcTransport } = require('../src/main/platform/agent/transport/node-ipc');
const { portPair, ipcPair } = require('./fakes/agent-ports');

const ECHO = path.join(__dirname, 'fakes', 'agent-echo.js');
const beat = (t) => encode({ kind: 'evt', type: 'beat', payload: { t } });
const tick = () => new Promise((r) => setTimeout(r, 20));
const forkEcho = () => fork(ECHO, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

// ---------- the in-memory pair ----------

test('memory: delivery is a microtask, never a call back into the sender', async () => {
  const [a, b] = memoryPair();
  const seen = [];
  b.onMessage((m) => seen.push(m));
  a.send(beat(1));
  assert.deepEqual(seen, []);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.t, 1);
  a.close();
});

test('memory: the wire carries a copy, and only what JSON can carry', async () => {
  const [a, b] = memoryPair();
  const seen = [];
  b.onMessage((m) => seen.push(m));
  const msg = beat(1);
  a.send(msg);
  msg.payload.t = 99; // changed after it went out
  await tick();
  assert.equal(seen[0].payload.t, 1);
  assert.notEqual(seen[0], msg);
  const cycle = beat(2);
  cycle.payload.self = cycle;
  assert.throws(() => a.send(cycle), TypeError);
  a.close();
});

test('memory: close ends both ends once, and nothing crosses after it', async () => {
  const [a, b] = memoryPair();
  const heard = { a: [], b: [] };
  const got = [];
  a.onClose((r) => heard.a.push(r));
  b.onClose((r) => heard.b.push(r));
  b.onMessage((m) => got.push(m));
  a.close();
  a.close();
  assert.deepEqual(heard.a, ['closed']);
  assert.deepEqual(heard.b, ['the peer closed']);
  a.send(beat(1));
  b.send(beat(2));
  await tick();
  assert.deepEqual(got, []);
});

test('memory: a message in flight to a peer that closes is dropped', async () => {
  const [a, b] = memoryPair();
  const got = [];
  b.onMessage((m) => got.push(m));
  a.send(beat(1));
  b.close();
  await tick();
  assert.deepEqual(got, []);
});

// ---------- the parent port ----------

test('parent port: a MessagePort-like object is required', () => {
  for (const bad of [null, undefined, {}, { postMessage() {} }, { on() {} }]) {
    assert.throws(() => parentPortTransport(bad), TypeError);
  }
});

test('parent port: both spellings of the message event are heard, and the port is started', () => {
  const [port] = portPair();
  const transport = parentPortTransport(port);
  assert.equal(port.started, 1);
  const seen = [];
  transport.onMessage((m) => seen.push(m));
  port.emit('message', { data: beat(1) }); // the value under `data`
  port.emit('message', beat(2));           // the value itself
  assert.deepEqual(seen.map((m) => m.payload.t), [1, 2]);
  transport.close();
});

test('parent port: the port closing ends the transport, once', () => {
  const [port] = portPair();
  const transport = parentPortTransport(port);
  const reasons = [];
  transport.onClose((r) => reasons.push(r));
  port.emit('close');
  port.emit('close');
  assert.deepEqual(reasons, ['the parent port closed']);
});

test('parent port: a send that cannot go out ends the transport with the reason', () => {
  const [port] = portPair();
  const transport = parentPortTransport(port);
  const reasons = [];
  transport.onClose((r) => reasons.push(r));
  port.close(); // the channel is gone under it
  transport.send(beat(1));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /send failed/);
});

test('parent port: close detaches from the port, closes it, and says so once', async () => {
  const [port, peer] = portPair();
  const transport = parentPortTransport(port);
  const seen = [];
  const reasons = [];
  let peerClosed = 0;
  peer.on('close', () => { peerClosed += 1; });
  transport.onMessage((m) => seen.push(m));
  transport.onClose((r) => reasons.push(r));
  transport.close();
  transport.close();
  await tick();
  assert.deepEqual(reasons, ['closed']);
  assert.equal(port.closed, 1);
  assert.equal(peerClosed, 1);
  port.emit('message', { data: beat(1) });
  assert.deepEqual(seen, []);
});

// ---------- the fork channel ----------

test('node-ipc: a process with a channel is required', () => {
  for (const bad of [null, undefined, {}, { send() {} }, { on() {} }]) {
    assert.throws(() => nodeIpcTransport(bad), TypeError);
  }
});

test('node-ipc: what it is told goes out, what the process hears comes in', async () => {
  const [proc, peer] = ipcPair();
  const transport = nodeIpcTransport(proc);
  const seen = [];
  transport.onMessage((m) => seen.push(m));
  transport.send(beat(1));
  peer.send(beat(2)); // the far end answers: that is what comes in on this one
  await tick();
  assert.deepEqual(proc.sent.map((m) => m.payload.t), [1]);
  assert.deepEqual(seen.map((m) => m.payload.t), [2]);
  transport.close();
});

test('node-ipc: exit and disconnect both end it, once, with what happened', () => {
  const [proc] = ipcPair();
  const transport = nodeIpcTransport(proc);
  const reasons = [];
  transport.onClose((r) => reasons.push(r));
  proc.emit('exit', 0, null);
  proc.emit('disconnect');
  assert.deepEqual(reasons, ['exit 0']);
  const [other] = ipcPair();
  const second = nodeIpcTransport(other);
  const said = [];
  second.onClose((r) => said.push(r));
  other.emit('exit', null, 'SIGKILL');
  assert.deepEqual(said, ['exit SIGKILL']);
});

test('node-ipc: close disconnects the channel and says so once', async () => {
  const [proc, peer] = ipcPair();
  const transport = nodeIpcTransport(proc);
  const reasons = [];
  let disconnected = 0;
  peer.on('disconnect', () => { disconnected += 1; });
  transport.onClose((r) => reasons.push(r));
  transport.close();
  transport.close();
  await tick();
  assert.deepEqual(reasons, ['closed']);
  assert.equal(proc.disconnected, 1);
  assert.equal(disconnected, 1);
  transport.send(beat(1));
  assert.deepEqual(proc.sent, []);
});

// A kill severs the channel and reaps the process: Node reports both, in whichever order it
// manages. The transport ends on the first of them and says so once; the reason names what
// happened, not a local close.
test('node-ipc: a killed child ends the transport, once', { timeout: 15000 }, async () => {
  const child = forkEcho();
  const transport = nodeIpcTransport(child);
  const back = new Promise((resolve) => transport.onMessage(resolve));
  const reasons = [];
  transport.onClose((r) => reasons.push(r));
  transport.send(beat(1));
  assert.equal((await back).payload.t, 1); // up and answering before it is killed
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  await tick(); // both events delivered: the second must not be a second ending
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /disconnected|SIGKILL/);
  transport.send(beat(2)); // the channel is gone: nowhere to go, and nothing thrown
});

test('node-ipc: close() lets the child go, and its exit is not a second ending', { timeout: 15000 }, async () => {
  const child = forkEcho();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const transport = nodeIpcTransport(child);
  const reasons = [];
  transport.onClose((r) => reasons.push(r));
  transport.close();
  await exited;
  assert.deepEqual(reasons, ['closed']);
});
