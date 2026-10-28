'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');
const { parseLine, toUpdate, overlayWindowId, startMacWindowWatch } = require('../src/main/mac/window-watch');

const line = (o) => JSON.stringify({ v: 1, fg: null, displays: [], wins: [], ...o });

test('mac helper line: windows and displays parsed, unknown fields dropped', () => {
  const snap = parseLine(line({
    fg: 42,
    displays: [{ id: 2, x: 0, y: 0, w: 2560, h: 1440, scale: 2 }, { id: 3, x: -1920, y: -200, w: 1920, h: 1080 }],
    wins: [{ id: 42, x: -250, y: 300, w: 700, h: 400, max: false, full: false, title: 'secret', owner: 'App' },
      { id: 7, x: 0, y: 0, w: 2560, h: 1440, max: true, full: true }],
    extra: 'ignored',
  }));
  assert.deepEqual(snap, {
    fg: 42,
    wins: [{ id: 42, x: -250, y: 300, w: 700, h: 400, max: false, full: false },
      { id: 7, x: 0, y: 0, w: 2560, h: 1440, max: true, full: true }],
    displays: [{ id: 2, x: 0, y: 0, w: 2560, h: 1440, scale: 2 }, { id: 3, x: -1920, y: -200, w: 1920, h: 1080, scale: 1 }],
  });
});

test('mac helper line: garbage is rejected or filtered', () => {
  for (const bad of ['', 'not json', 'null', '[]', '{"v":2,"wins":[]}', '{"v":1}', '{"v":1,"wins":{}}']) {
    assert.equal(parseLine(bad), null, bad);
  }
  const snap = parseLine(line({
    fg: -1,
    wins: [null, { id: 0, x: 0, y: 0, w: 10, h: 10 }, { id: 1.5, x: 0, y: 0, w: 10, h: 10 }, { id: 2, x: '1', y: 0, w: 10, h: 10 },
      { id: 3, x: 0, y: 0, w: 0, h: 10 }, { id: 4, x: 1e9, y: 0, w: 10, h: 10 }, { id: 5, x: NaN, y: 0, w: 10, h: 10 },
      { id: 6, x: 1, y: 2, w: 3, h: 4, max: 'yes' }],
  }));
  assert.equal(snap.fg, null);
  assert.deepEqual(snap.wins, [{ id: 6, x: 1, y: 2, w: 3, h: 4, max: false, full: false }]);
  const many = parseLine(line({ wins: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, x: 0, y: 0, w: 300, h: 200 })) }));
  assert.equal(many.wins.length, 40);
});

test('mac update: shifted into the overlay, off-screen windows dropped, Windows-only fields empty', () => {
  const snap = parseLine(line({
    fg: 1,
    wins: [
      { id: 1, x: -250, y: 300, w: 700, h: 400 }, // partly off the left edge: kept
      { id: 2, x: 2600, y: 100, w: 800, h: 600 }, // on a display to the right: dropped
      { id: 3, x: -1900, y: -100, w: 800, h: 600 }, // on a display up-left (negative space): dropped
      { id: 4, x: 0, y: 30, w: 2560, h: 1312, max: true },
    ],
  }));
  const update = toUpdate(snap, { x: 0, y: 30, width: 2560, height: 1410 });
  assert.deepEqual(update, {
    fg: 1, taskbar: false, ai: [], game: null, usb: [], plug: null,
    wins: [{ id: 1, x: -250, y: 270, w: 700, h: 400, max: false, full: false }, { id: 4, x: 0, y: 0, w: 2560, h: 1312, max: true, full: false }],
  });
  // her overlay on the left display: the same windows seen from there
  const left = toUpdate(snap, { x: -1920, y: -200, width: 1920, height: 1080 });
  assert.deepEqual(left.wins.map((w) => [w.id, w.x, w.y]), [[1, 1670, 500], [3, 20, 100]]);
});

test('mac overlay window id comes from the media source id', () => {
  assert.equal(overlayWindowId({ getMediaSourceId: () => 'window:74027:0' }), 74027);
  assert.equal(overlayWindowId({ getMediaSourceId: () => 'screen:1:0' }), null);
  assert.equal(overlayWindowId({ getMediaSourceId() { throw new Error('destroyed'); } }), null);
});

function fakeOverlay() {
  return { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }), getMediaSourceId: () => 'window:99:0' };
}

function fakeSpawn(calls) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, child });
    return child;
  };
}

test('mac watch: missing helper keeps the base overlay and spawns nothing', () => {
  const calls = [];
  const logs = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() { throw new Error('no update expected'); },
    helper: '/nonexistent/capri-windows', spawn: fakeSpawn(calls), log: (...a) => logs.push(a.join(' ')) });
  assert.equal(watch.available, false);
  assert.equal(calls.length, 0);
  watch.refresh();
  watch.stop();
  assert.match(logs[0], /not built/);
});

test('mac watch: helper lines become updates; restarts are bounded', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const updates = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  assert.equal(watch.available, true);
  assert.deepEqual(calls[0].args, ['--parent', String(process.pid), '--watch-stdin', '--self-window', '99']);

  return new Promise((resolve) => {
    calls[0].child.stdout.write(`garbage\n${line({ fg: 5, wins: [{ id: 5, x: 10, y: 20, w: 300, h: 200 }] })}\n`);
    setImmediate(() => {
      assert.equal(updates.length, 1);
      assert.deepEqual(updates[0].wins, [{ id: 5, x: 10, y: 20, w: 300, h: 200, max: false, full: false }]);
      watch.refresh(); // her window moved: the last snapshot again
      assert.equal(updates.length, 2);

      // a helper that keeps dying is restarted three times, then left alone
      for (let i = 0; i < 5; i++) {
        calls.at(-1).child.emit('close', 1);
        t.mock.timers.tick(3000);
      }
      assert.equal(calls.length, 4);

      // stopped: the helper is killed and not brought back
      const again = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, helper: __filename, spawn: fakeSpawn(calls), log() {} });
      again.stop();
      assert.equal(calls.at(-1).child.killed, true);
      calls.at(-1).child.emit('close', null);
      t.mock.timers.tick(3000);
      assert.equal(calls.length, 5);
      resolve();
    });
  });
});

test('mac watch: a JSON line split across stdout chunks is joined before parsing', async () => {
  const calls = [];
  const updates = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u), helper: __filename, spawn: fakeSpawn(calls), log() {} });
  const full = line({ fg: 5, wins: [{ id: 5, x: 10, y: 20, w: 300, h: 200 }] });
  const out = calls[0].child.stdout;
  out.write(full.slice(0, 17));
  await new Promise(setImmediate);
  assert.equal(updates.length, 0);
  out.write(`${full.slice(17)}\n${full.slice(0, 5)}`);
  await new Promise(setImmediate);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fg, 5);
});

test('mac watch: onState follows the helper like the Windows/Linux watchers', async (t) => {
  const states = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok),
    helper: '/nonexistent/capri-windows', spawn: fakeSpawn([]), log() {} });
  assert.deepEqual(states, [false]); // no helper: tracking off, the base overlay stays

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  states.length = 0;
  const calls = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  calls[0].child.stdout.write('garbage\n');
  await new Promise(setImmediate);
  assert.deepEqual(states, []); // not a snapshot: not running yet
  calls[0].child.stdout.write(`${line({})}\n${line({ fg: 3 })}\n`);
  await new Promise(setImmediate);
  assert.deepEqual(states, [true]); // once per helper run, not per line
  for (let i = 0; i < 4; i++) {
    calls.at(-1).child.emit('close', 1);
    t.mock.timers.tick(3000);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(states, [true, false]); // gave up after three restarts
});

test('mac watch: stop() during a pending restart spawns nothing more, later lines are ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const updates = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  calls[0].child.emit('close', 1); // the helper died: a restart is pending
  watch.stop();
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1);

  const again = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  again.stop();
  calls.at(-1).child.stdout.write(`${line({ fg: 1 })}\n`);
  return new Promise((resolve) => setImmediate(() => {
    assert.equal(updates.length, 0);
    resolve();
  }));
});

test('mac watch: a helper that cannot be executed (no exit event) is still retried, then given up', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'capri-windows');
  fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o644 }); // present but not executable: EACCES
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const states = [];
  const logs = [];
  const spawn = (...a) => {
    const c = realSpawn(...a);
    children.push(new Promise((r) => c.once('close', r)));
    return c;
  };
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok), helper, spawn, log: (...a) => logs.push(a.join(' ')) });
  for (let i = 0; i < 4; i++) {
    await children[i];
    await new Promise(setImmediate);
    t.mock.timers.tick(3000);
  }
  assert.equal(children.length, 4);
  assert.deepEqual(states, [false]);
  assert.ok(logs.some((l) => /EACCES/.test(l)));
});
