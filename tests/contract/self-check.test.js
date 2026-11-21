'use strict';

// The contract suite, proven two ways: a minimal conforming reference passes all of it, and each
// listed requirement has a mutant that breaks exactly it — a check that cannot fail is worthless.
// This is not FakeShell (S2-T2): no command journal, no test surface beyond the drive.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runShellContract, CHECKS } = require('./shell.contract');

const CAPS = {
  tier: 1, backend: 'kwin', windows: true, pointer: true,
  apps: { list: true, close: true }, hotkey: true,
  screenshot: ['spectacle', 'portal'],
  overlay: { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' },
};

function observable({ noLast = false, noUnsub = false } = {}) {
  const subs = new Set();
  let last;
  const obs = {
    subscribe(fn) { subs.add(fn); return noUnsub ? () => {} : () => subs.delete(fn); },
    publish(value) { last = value; for (const fn of [...subs]) fn(value); },
    clear() { subs.clear(); },
  };
  if (!noLast) obs.last = () => last;
  return obs;
}

const stoppedError = () => Object.assign(new Error('the shell is stopped'), { code: 'stopped' });

// broken: one flag per mutant, each breaking exactly one contractual requirement
function makeReference(broken = {}) {
  let state = 'idle';
  let starts = 0;
  let stalled = false;
  const pending = new Set();
  const health = observable();
  const frames = observable(broken);
  const pointer = observable();
  const facts = observable();
  const onHotkey = observable();

  const request = (result) => () => {
    if (broken.syncThrow) throw new Error('a synchronous throw');
    if (state === 'stopped') return Promise.reject(stoppedError());
    let settle;
    const p = new Promise((resolve, reject) => { settle = { resolve, reject, result }; });
    if (stalled) pending.add(settle);
    else settle.resolve(result);
    return p;
  };

  const shell = {
    caps: () => ({ ...CAPS, backend: broken.backendFlip && state === 'ready' ? 'x11' : CAPS.backend }),
    health,
    observe: { frames, pointer, facts, workArea: request(null) },
    overlay: {
      request: async (r) => r,
      raise() {}, focus() {}, zones() {}, identity() {},
    },
    control: { hotkey: request(true), onHotkey, closeApps: request({ running: false }) },
    os: {
      windows: request([]),
      launchables: request([]),
      launch: request(undefined),
      media: request(true),
      search: request([]),
      screenshot: request(null),
      terminal: request(true),
    },
    setDisplays() {},
    start: async () => {
      starts += 1;
      if (broken.startTwice && starts > 1) throw new Error('started twice');
      if (state === 'ready') return;
      state = 'ready';
      health.publish({ state: 'ready' });
    },
    stop: async () => {
      if (state === 'stopped') return;
      state = 'stopped';
      health.publish({ state: 'stopped' });
      if (!broken.stopKeepsPending) for (const s of pending) s.reject(stoppedError());
      pending.clear();
      if (!broken.stopKeepsSubs) {
        frames.clear(); pointer.clear(); facts.clear(); onHotkey.clear(); health.clear();
      }
    },
  };

  const drive = {
    frame: (f) => frames.publish(f),
    stall: () => {
      stalled = true;
      return () => {
        stalled = false;
        for (const s of pending) s.resolve(s.result);
        pending.clear();
      };
    },
  };
  return { shell, drive };
}

// A conforming implementation passes the whole contract.
runShellContract('contract self-check', () => makeReference());

// And the contract bites: each mutant must fail its own check.
const MUTANTS = [
  ['start() that refuses a second call', 'start-idempotent', { startTwice: true }],
  ['caps().backend that changes after start', 'start-idempotent', { backendFlip: true }],
  ['frames without last()', 'frames-replay', { noLast: true }],
  ['an unsubscribe that does nothing', 'unsubscribe', { noUnsub: true }],
  ['stop() that leaves pending requests hanging', 'stop-pending', { stopKeepsPending: true }],
  ['stop() that keeps subscribers', 'stop-silence', { stopKeepsSubs: true }],
  ['a request method that throws synchronously', 'request-shape', { syncThrow: true }],
];

for (const [label, id, broken] of MUTANTS) {
  test(`the contract bites: ${label}`, { timeout: 5000 }, async () => {
    const check = CHECKS.find((c) => c.id === id);
    assert.ok(check, `no check with id ${id}`);
    const { shell, drive } = makeReference(broken);
    try {
      await assert.rejects(() => check.run(shell, drive));
    } finally {
      await shell.stop().catch(() => {});
    }
  });
}