'use strict';

// One set of checks every pipe must pass: the parent port, the fork channel, the in-memory pair.
// The far end is an echo (tests/fakes/agent-echo.js), so a message is proven to have crossed the
// channel by coming back decoded, and a refusal is proven by silence with the next message still
// arriving — the channel is ordered, so the sentinel behind the junk says the junk was received
// and dropped, not lost on the way.

const test = require('node:test');
const assert = require('node:assert/strict');
const { decode, encode } = require('../../src/main/platform/agent/protocol');
const { CASES, REFUSED } = require('../fakes/agent-messages');

// Messages as they arrive, with a wait that fails instead of hanging the runner.
function inbox(transport, label, note) {
  const queue = [];
  const waiting = [];
  transport.onMessage((raw) => {
    const entry = waiting.shift();
    if (entry) entry.resolve(raw);
    else queue.push(raw);
  });
  return {
    next(ms = 10000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const entry = {
          resolve: (raw) => { clearTimeout(entry.timer); resolve(raw); },
        };
        entry.timer = setTimeout(() => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error(`${label}: nothing came back within ${ms} ms${note ? ` — ${note()}` : ''}`));
        }, ms);
        waiting.push(entry);
      });
    },
    pending: () => queue.length,
  };
}

const CHECKS = [
  {
    name: 'every message of the catalog crosses the wire and comes back',
    run: async (transport, box) => {
      for (const c of CASES) {
        const sent = encode(c.env);
        transport.send(sent);
        assert.deepEqual(decode(await box.next()), sent, c.name);
      }
      assert.equal(box.pending(), 0);
    },
  },
  {
    name: 'a refused message is dropped, and the next one still arrives',
    run: async (transport, box) => {
      const sentinel = encode({ kind: 'evt', type: 'beat', payload: { t: 1 } });
      for (const bad of REFUSED) {
        transport.send(bad.raw); // raw: this is what a sender puts on the wire, not what encode would build
        transport.send(sentinel);
        assert.deepEqual(decode(await box.next()), sentinel, bad.name);
      }
      assert.equal(box.pending(), 0);
    },
  },
  {
    name: 'order is preserved',
    run: async (transport, box) => {
      const beats = [1, 2, 3, 4, 5].map((t) => encode({ kind: 'evt', type: 'beat', payload: { t } }));
      for (const b of beats) transport.send(b);
      for (const b of beats) assert.deepEqual(decode(await box.next()), b);
    },
  },
  {
    name: 'close() ends the channel and says so once',
    run: async (transport, box) => {
      const reasons = [];
      transport.onClose((r) => reasons.push(r));
      transport.close();
      transport.close();
      assert.equal(reasons.length, 1);
      transport.send(encode({ kind: 'evt', type: 'beat', payload: { t: 9 } }));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(box.pending(), 0);
    },
  },
];

/**
 * @param {string} name
 * @param {(t: any) => any} makeEcho  → { transport, note? }: one end of a channel whose far end echoes
 */
function runTransportContract(name, makeEcho) {
  for (const check of CHECKS) {
    test(`${name}: ${check.name}`, { timeout: 30000 }, async (t) => {
      const made = await makeEcho(t);
      const box = inbox(made.transport, name, made.note);
      try {
        await check.run(made.transport, box);
      } finally {
        made.transport.close();
      }
    });
  }
}

module.exports = { runTransportContract, CHECKS };
