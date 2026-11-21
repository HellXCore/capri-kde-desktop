'use strict';

// FakeShell under the same contract every real implementation must pass, plus checks of its own
// test surface: a fake whose controls do nothing would make every test built on it vacuous.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runShellContract } = require('./shell.contract');
const { createFakeShell } = require('../fakes/fake-shell');

runShellContract('FakeShell', () => createFakeShell());

const frame = (rev) => ({ rev, fg: 0, dock: false, front: { ai: [], game: null }, wins: [], self: null });

test('fake: emitFrame/emitPointer/emitFact/emitHotkey reach subscribers and last()', () => {
  const f = createFakeShell();
  const seen = { frame: [], pointer: [], fact: [], hotkey: [] };
  f.shell.observe.frames.subscribe((v) => seen.frame.push(v));
  f.shell.observe.pointer.subscribe((v) => seen.pointer.push(v));
  f.shell.observe.facts.subscribe((v) => seen.fact.push(v));
  f.shell.control.onHotkey.subscribe((v) => seen.hotkey.push(v));
  f.emitFrame(frame(1));
  f.emitPointer({ x: 10, y: 20 });
  f.emitFact({ kind: 'devices', usb: ['STICK'], plug: null });
  f.emitHotkey('stow');
  assert.deepEqual(seen.frame, [frame(1)]);
  assert.deepEqual(seen.pointer, [{ x: 10, y: 20 }]);
  assert.deepEqual(seen.fact, [{ kind: 'devices', usb: ['STICK'], plug: null }]);
  assert.deepEqual(seen.hotkey, ['stow']);
  assert.deepEqual(f.shell.observe.frames.last(), frame(1));
  assert.deepEqual(f.shell.observe.pointer.last(), { x: 10, y: 20 });
});

test('fake: setCaps merges cells; caps() is a copy, not the internal state', () => {
  const f = createFakeShell();
  const taken = f.shell.caps();
  taken.overlay.input = 'xshape';
  taken.apps.list = false;
  assert.equal(f.shell.caps().overlay.input, 'toggle');
  assert.equal(f.shell.caps().apps.list, true);
  f.setCaps({ windows: false, overlay: { input: 'passthrough' }, apps: { close: false } });
  const c = f.shell.caps();
  assert.equal(c.windows, false);
  assert.equal(c.overlay.input, 'passthrough');
  assert.equal(c.overlay.place, 'compositor'); // untouched cells kept
  assert.equal(c.apps.close, false);
  assert.equal(c.apps.list, true);
  assert.equal(c.backend, 'kwin');
});

test('fake: setHealth publishes state and reason without touching the lifecycle', async () => {
  const f = createFakeShell();
  const seen = [];
  f.shell.health.subscribe((h) => seen.push(h));
  await f.shell.start();
  f.setHealth('degraded', 'bus lost');
  f.setHealth('ready');
  assert.deepEqual(seen, [{ state: 'ready' }, { state: 'degraded', reason: 'bus lost' }, { state: 'ready' }]);
  assert.equal(await f.shell.os.media('pause'), true); // requests still answer
  await f.shell.stop();
});

test('fake: the journal records every call, with its arguments, in order', async () => {
  const f = createFakeShell();
  const rect = { x: 0, y: 0, w: 1920, h: 1040 };
  f.shell.setDisplays([{ id: 1 }]);
  f.shell.overlay.identity({ pid: 7, title: 'capri-overlay', xid: null });
  await f.shell.overlay.request(rect);
  f.shell.overlay.zones({ rects: [], dpr: 1 });
  f.shell.overlay.focus(true);
  f.shell.overlay.raise();
  await f.shell.control.hotkey('stow', 'Ctrl+Alt+C');
  await f.shell.os.media('pause');
  assert.deepEqual(f.journal.map((c) => c.op), [
    'setDisplays', 'overlay.identity', 'overlay.request', 'overlay.zones',
    'overlay.focus', 'overlay.raise', 'control.hotkey', 'os.media',
  ]);
  assert.deepEqual(f.journal[2].args, [rect]);
  assert.deepEqual(f.journal[4].args, [true]);
  assert.deepEqual(f.journal[7].args, ['pause']);
});

test('fake: stall holds requests, release answers them with the defaults', async () => {
  const f = createFakeShell();
  await f.shell.start();
  const release = f.drive.stall();
  const rect = { x: 5, y: 6, w: 100, h: 80 };
  const asked = f.shell.overlay.request(rect);
  const media = f.shell.os.media('next');
  let settled = false;
  asked.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  release();
  assert.deepEqual(await asked, rect); // the confirmed rect is the requested one by default
  assert.equal(await media, true);
  assert.equal(await f.shell.os.media('pause'), true); // after release: immediate again
  await f.shell.stop();
});

test('fake: a request made after stop() rejects with code "stopped"', async () => {
  const f = createFakeShell();
  await f.shell.start();
  await f.shell.stop();
  await assert.rejects(f.shell.os.windows(), (err) => err instanceof Error && err.code === 'stopped');
  await assert.rejects(f.shell.overlay.request({ x: 0, y: 0, w: 1, h: 1 }), { code: 'stopped' });
});

test('fake: start() is idempotent — ready is published once', async () => {
  const f = createFakeShell();
  const seen = [];
  f.shell.health.subscribe((h) => seen.push(h.state));
  await f.shell.start();
  await f.shell.start();
  assert.deepEqual(seen, ['ready']);
  await f.shell.stop();
  assert.deepEqual(seen, ['ready', 'stopped']);
});