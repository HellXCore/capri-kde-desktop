'use strict';

// The DesktopShell contract (core/ports.js): one set of checks every implementation must pass —
// FakeShell, LegacyShell (until it is removed), AgentShell over each transport. Plain Node, no
// Electron, no desktop: makeShell brings an isolated world (fake bus, fake X, fake exec), so a
// request method can never touch the real system even though the contract calls it.
//
//   runShellContract(name, makeShell)
//     makeShell(t) -> { shell, drive }
//       drive.frame(f)  publish a frame as the platform would; safe after stop() (goes nowhere)
//       drive.stall()   hold every request; returns release(), letting held requests finish
//     A bare shell (the plan's sketch) is accepted too; the event checks then fail with a clear
//     message asking for a drive — deterministic events are the point of this suite.
//
// Frame payloads are opaque here: delivery, order, replay and silence are the port's mechanics;
// the frame's own shape is pinned by the S3 golden tests. CHECKS is exported so the suite itself
// can be proven to bite (self-check.test.js runs it against deliberately broken shells).

const test = require('node:test');
const assert = require('node:assert/strict');
const { v } = require('../../src/main/core/validate');

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, w: 1920, h: 1080 }, workArea: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1 };
const frame = (rev) => ({ rev, fg: 0, dock: false, front: { ai: [], game: null }, wins: [], self: null });

// Capabilities (ports.js): a closed shape — an extra key is a port change, which needs a PR.
const capsCheck = v.obj({
  tier: v.oneOf([1, 2]),
  backend: v.oneOf(['kwin', 'x11', 'generic']),
  windows: v.bool(),
  pointer: v.bool(),
  apps: v.obj({ list: v.bool(), close: v.bool() }),
  hotkey: v.bool(),
  screenshot: v.arr(v.oneOf(['spectacle', 'portal', 'capturer']), { max: 3 }),
  overlay: v.obj({
    place: v.oneOf(['client', 'compositor']),
    stacking: v.oneOf(['client', 'compositor']),
    focus: v.oneOf(['client', 'compositor']),
    input: v.oneOf(['xshape', 'toggle', 'passthrough']),
  }),
});

const SURFACE = [
  'caps', 'start', 'stop', 'setDisplays',
  'health.subscribe',
  'observe.frames.subscribe', 'observe.pointer.subscribe', 'observe.facts.subscribe', 'observe.workArea',
  'overlay.request', 'overlay.raise', 'overlay.focus', 'overlay.zones', 'overlay.identity',
  'control.hotkey', 'control.onHotkey.subscribe', 'control.closeApps',
  'os.windows', 'os.launchables', 'os.launch', 'os.media', 'os.search', 'os.screenshot', 'os.terminal',
];

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A promise that must settle: a broken shell fails the check instead of hanging the runner.
const deadline = (p, ms, msg) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(msg)), ms);
  p.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
});

// Delivery may be async (a forked agent): wait for the effect, not for a fixed delay.
const until = async (fn, msg) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > 2000) throw new Error(msg);
    await sleep(10);
  }
};

const needDrive = (drive) => assert.ok(
  drive && typeof drive.frame === 'function' && typeof drive.stall === 'function',
  'wire a drive: makeShell must return { shell, drive: { frame, stall } }',
);

// Every request method, with arguments a real implementation must refuse rather than act on.
const requests = (shell) => [
  () => shell.os.windows(),
  () => shell.os.launchables(),
  () => shell.os.launch('capri-contract-missing'),
  () => shell.os.media('pause'),
  () => shell.os.search('capri-contract'),
  () => shell.os.screenshot({ display: DISPLAY, multi: false }),
  () => shell.os.terminal(['true']),
  () => shell.control.hotkey('contract', 'Ctrl+Alt+Shift+F12'),
  () => shell.control.closeApps([], { force: false }),
  () => shell.observe.workArea(DISPLAY.id),
];

const CHECKS = [
  {
    id: 'surface',
    name: 'the port surface is complete',
    run: async (shell) => {
      for (const path of SURFACE) assert.equal(typeof at(shell, path), 'function', path);
      assert.doesNotThrow(() => shell.setDisplays([DISPLAY]));
    },
  },
  {
    id: 'caps-shape',
    name: 'caps() is the full Capabilities shape, before start()',
    run: async (shell) => {
      capsCheck(shell.caps());
    },
  },
  {
    id: 'start-idempotent',
    name: 'start() is idempotent; caps().backend is a static fact',
    run: async (shell) => {
      const before = shell.caps().backend;
      await shell.start();
      await shell.start();
      capsCheck(shell.caps());
      assert.equal(shell.caps().backend, before);
      await shell.stop();
      assert.equal(shell.caps().backend, before);
    },
  },
  {
    id: 'frames-replay',
    name: 'observe.frames delivers in order; last() replays the newest to a late subscriber',
    run: async (shell, drive) => {
      needDrive(drive);
      await shell.start();
      assert.equal(typeof shell.observe.frames.last, 'function', 'frames must support last()');
      const seen = [];
      const off = shell.observe.frames.subscribe((f) => seen.push(f));
      drive.frame(frame(1));
      drive.frame(frame(2));
      await until(() => seen.length >= 2, 'frames were not delivered');
      assert.deepEqual(seen, [frame(1), frame(2)]);
      assert.deepEqual(shell.observe.frames.last(), frame(2));
      // a late subscriber catches up through last(), then hears what comes next
      const late = [];
      const offLate = shell.observe.frames.subscribe((f) => late.push(f));
      assert.deepEqual(shell.observe.frames.last(), frame(2));
      drive.frame(frame(3));
      await until(() => late.length >= 1, 'a late subscriber heard nothing');
      assert.deepEqual(late, [frame(3)]);
      off();
      offLate();
    },
  },
  {
    id: 'unsubscribe',
    name: 'unsubscribe stops delivery; saying it twice is harmless',
    run: async (shell, drive) => {
      needDrive(drive);
      await shell.start();
      const seen = [];
      const off = shell.observe.frames.subscribe((f) => seen.push(f));
      drive.frame(frame(1));
      await until(() => seen.length >= 1, 'the first frame was not delivered');
      off();
      assert.doesNotThrow(() => off());
      drive.frame(frame(2));
      // last() moves even with no subscribers: the barrier proving frame 2 was processed
      await until(() => shell.observe.frames.last()?.rev === 2, 'the second frame was not processed');
      assert.deepEqual(seen, [frame(1)]);
    },
  },
  {
    id: 'stop-pending',
    name: 'stop() settles pending requests; every rejection carries code "stopped"',
    run: async (shell, drive) => {
      needDrive(drive);
      await shell.start();
      const release = drive.stall();
      const outcomes = [
        shell.os.windows(),
        shell.os.screenshot({ display: DISPLAY, multi: false }),
        shell.os.search('capri-contract'),
        shell.control.closeApps(['capri-contract'], { force: false }),
        shell.observe.workArea(DISPLAY.id),
      ].map((p) => p.then(() => 'resolved', (err) => err));
      await shell.stop();
      const settled = await deadline(Promise.all(outcomes), 1000, 'a pending request never settled after stop()');
      for (const o of settled) {
        if (o === 'resolved') continue; // finished before stop() landed: allowed
        assert.ok(o instanceof Error, 'a rejection must be an Error');
        assert.equal(o.code, 'stopped');
      }
      assert.ok(settled.some((o) => o !== 'resolved'), 'stalled requests must be rejected by stop(), not left to the stall');
      release();
    },
  },
  {
    id: 'stop-silence',
    name: 'stop() unsubscribes everyone: nothing is delivered after',
    run: async (shell, drive) => {
      needDrive(drive);
      await shell.start();
      const seen = [];
      shell.observe.frames.subscribe((f) => seen.push(f));
      drive.frame(frame(1));
      await until(() => seen.length >= 1, 'the first frame was not delivered');
      await shell.stop();
      drive.frame(frame(2));
      await sleep(150); // absence is proven by a grace period: nothing may arrive
      assert.deepEqual(seen, [frame(1)]);
    },
  },
  {
    id: 'request-shape',
    name: 'every request method returns a Promise, never throws synchronously',
    run: async (shell) => {
      await shell.start();
      const settled = [];
      for (const call of requests(shell)) {
        let p;
        assert.doesNotThrow(() => { p = call(); }, 'a request method threw synchronously');
        assert.ok(p && typeof p.then === 'function', 'a request method did not return a Promise');
        settled.push(p.then(() => {}, () => {})); // outcomes are not this check's subject
      }
      await shell.stop();
      await deadline(Promise.all(settled), 1000, 'requests did not settle after stop()');
    },
  },
];

function runShellContract(name, makeShell) {
  for (const check of CHECKS) {
    test(`${name}: ${check.name}`, { timeout: 5000 }, async (t) => {
      const made = await makeShell(t);
      const shell = made && made.shell ? made.shell : made;
      const drive = made && made.shell ? made.drive : undefined;
      try {
        await check.run(shell, drive);
      } finally {
        // cleanup: a check may have stopped already; a throw here is swallowed
        await shell.stop().catch(() => {});
      }
    });
  }
}

module.exports = { runShellContract, CHECKS };