'use strict';

// The transport contract on every pipe the agent speaks: the in-memory pair, the parent port of a
// utility process (on stand-in ports), and node IPC over a real forked process. The last one is the
// point of the suite: the same catalog, the same refusals, across a genuine process boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { runTransportContract } = require('./transport.contract');
const { encode } = require('../../src/main/platform/agent/protocol');
const { memoryPair } = require('../../src/main/platform/agent/transport/memory');
const { parentPortTransport } = require('../../src/main/platform/agent/transport/parent-port');
const { nodeIpcTransport } = require('../../src/main/platform/agent/transport/node-ipc');
const { echoOn } = require('../fakes/agent-echo');
const { portPair } = require('../fakes/agent-ports');
const { REFUSED } = require('../fakes/agent-messages');

const ECHO = path.join(__dirname, '..', 'fakes', 'agent-echo.js');

runTransportContract('memory', () => {
  const [a, b] = memoryPair();
  echoOn(b);
  return { transport: a };
});

runTransportContract('parent port', () => {
  const [a, b] = portPair();
  echoOn(parentPortTransport(b));
  return { transport: parentPortTransport(a) };
});

runTransportContract('node-ipc (a real fork)', (t) => {
  const child = fork(ECHO, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
  t.after(() => { child.kill(); });
  return { transport: nodeIpcTransport(child), note: () => `child stderr: ${stderr || '(empty)'}` };
});

// The far end's own accounting, where it can be read directly: every refusal counted and logged,
// nothing repaired, and the channel still serving afterwards.
test('the far end counts and logs every refusal, and goes on serving', async () => {
  const [a, b] = memoryPair();
  const far = echoOn(b);
  const seen = [];
  a.onMessage((raw) => seen.push(raw));
  for (const bad of REFUSED) a.send(bad.raw);
  a.send(encode({ kind: 'evt', type: 'beat', payload: { t: 1 } }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 1, 'only the valid message came back');
  assert.equal(far.codec.invalid(), REFUSED.length);
  assert.equal(far.lines.length, REFUSED.length);
  assert.ok(far.lines.every(([level, msg]) => level === 'warn' && /protocol\.invalid/.test(msg)));
  a.close();
});
