'use strict';

// The agent the shell talks to in tests. It speaks the real catalog — hello → ready, req → res,
// beats — and answers with the same results table the protocol tests use (agent-messages.js).
// On top of that it takes control messages that are NOT in the catalog ('fake.*'), so a test can
// make it emit a frame, hold its answers, go silent or die. A real agent refuses those types; this
// is a double, and a back door is the only way to drive a forked process deterministically.
//
// The same file is the entry of a real forked child (tests/fakes/agent-launcher.js forks it).

const { createCodec, encode } = require('../../src/main/platform/agent/protocol');
const { nodeIpcTransport } = require('../../src/main/platform/agent/transport/node-ipc');
const { RESULTS } = require('./agent-messages');

const CAPS = {
  tier: 1, backend: 'kwin', windows: true, pointer: true,
  apps: { list: true, close: true }, hotkey: true,
  screenshot: ['spectacle', 'portal'],
  overlay: { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' },
};

const EVENTS = {
  'fake.frame': 'frame', 'fake.pointer': 'pointer', 'fake.fact': 'fact', 'fake.hotkey': 'hotkey',
  'fake.health': 'health', 'fake.actual': 'overlay.actual', 'fake.beat': 'beat',
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeAgentOn(transport, { caps = CAPS, beatMs = 1000, log = silent, onExit = () => {} } = {}) {
  const codec = createCodec({ log });
  const received = [];      // every catalog message, decoded
  const held = [];          // requests parked by fake.stall
  const overrides = new Map();
  let stalled = false;
  let muted = false;
  let beat = null;

  const send = (env) => transport.send(encode(env));
  const stopBeat = () => { if (beat) clearInterval(beat); beat = null; };
  const startBeat = () => {
    if (beatMs <= 0 || beat) return;
    beat = setInterval(() => { if (!muted) send({ kind: 'evt', type: 'beat', payload: { t: Date.now() } }); }, beatMs);
    beat.unref?.();
  };
  const die = () => { stopBeat(); transport.close(); onExit(); };

  const answer = (msg) => {
    const over = overrides.get(msg.type);
    if (over?.err) return send({ kind: 'res', type: msg.type, id: msg.id, err: over.err });
    send({ kind: 'res', type: msg.type, id: msg.id, payload: over ? over.payload : (RESULTS[msg.type] ?? null) });
  };

  const control = (type, payload = {}) => {
    if (EVENTS[type]) return send({ kind: 'evt', type: EVENTS[type], payload });
    switch (type) {
      case 'fake.stall': stalled = true; return;
      case 'fake.release': stalled = false; for (const msg of held.splice(0)) answer(msg); return;
      case 'fake.mute': muted = true; return;
      case 'fake.exit': die(); return;
      case 'fake.raw': transport.send(payload); return;
      case 'fake.override': overrides.set(payload.type, payload); return;
      default: return;
    }
  };

  const handle = (msg) => {
    received.push(msg);
    if (msg.kind === 'cmd') {
      if (msg.type === 'hello' && !muted) { send({ kind: 'evt', type: 'ready', payload: { proto: 1, caps } }); startBeat(); }
      if (msg.type === 'shutdown') die();
      return;
    }
    if (msg.kind === 'req' && !muted) { if (stalled) held.push(msg); else answer(msg); }
  };

  transport.onMessage((raw) => {
    if (raw && typeof raw === 'object' && typeof raw.type === 'string' && raw.type.startsWith('fake.')) {
      return control(raw.type, raw.payload || {});
    }
    const msg = codec.read(raw);
    if (msg) handle(msg);
  });

  return { transport, codec, received, control, close: die };
}

module.exports = { fakeAgentOn, CAPS };

if (require.main === module) fakeAgentOn(nodeIpcTransport(process), { onExit: () => process.exit(0) });