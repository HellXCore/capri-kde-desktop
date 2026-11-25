'use strict';

// The work-area cache (platform/shell/work-area.js): the port's answers kept per display, failures
// and overtaken refreshes reading as no answer, and the change signal the caller refits on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkArea } = require('../src/main/platform/shell/work-area');
const { createFakeShell } = require('./fakes/fake-shell');

const RECT = { x: 0, y: 32, w: 1920, h: 1048 };

test('no refresh yet: no answer for any display', () => {
  const f = createFakeShell();
  const wa = createWorkArea({ shell: f.shell });
  assert.equal(wa.get(1), null);
});

test('null answers stay null and change nothing (all LegacyShell ever says)', async () => {
  const f = createFakeShell();
  const wa = createWorkArea({ shell: f.shell });
  assert.equal(await wa.refresh([1, 2]), false);
  assert.equal(wa.get(1), null);
  assert.equal(wa.get(2), null);
  assert.equal(await wa.refresh([1, 2]), false);
});

test('a known area is kept and served; the first answer changes, the same again does not', async () => {
  const f = createFakeShell();
  const wa = createWorkArea({ shell: f.shell });
  f.setWorkArea(RECT);
  assert.equal(await wa.refresh([7]), true);
  assert.deepEqual(wa.get(7), RECT);
  assert.equal(await wa.refresh([7]), false);
  f.setWorkArea({ ...RECT, y: 40 });
  assert.equal(await wa.refresh([7]), true);
  assert.deepEqual(wa.get(7), { ...RECT, y: 40 });
});

test('back to null is a change; a display gone from the list is a change', async () => {
  const f = createFakeShell();
  const wa = createWorkArea({ shell: f.shell });
  f.setWorkArea(RECT);
  await wa.refresh([1, 2]);
  f.setWorkArea(null);
  assert.equal(await wa.refresh([1, 2]), true);
  assert.equal(wa.get(1), null);
  f.setWorkArea(RECT);
  await wa.refresh([1, 2]);
  assert.equal(await wa.refresh([1]), true); // display 2's answer no longer applies
  assert.equal(wa.get(2), null);
  assert.equal(await wa.refresh([]), true);
  assert.equal(wa.get(1), null);
});

test('a failed request reads as no answer, never a stale area', async () => {
  const f = createFakeShell();
  const wa = createWorkArea({ shell: f.shell });
  f.setWorkArea(RECT);
  await wa.refresh([1]);
  await f.shell.stop(); // every request now rejects with code 'stopped'
  assert.equal(await wa.refresh([1]), true);
  assert.equal(wa.get(1), null);
});

test('an overtaken refresh is dropped: the newest answers win', async () => {
  // hand-made deferreds: two refreshes in flight, the older one resolving last
  const calls = [];
  const shell = { observe: { workArea: (id) => new Promise((resolve) => calls.push({ id, resolve })) } };
  const wa = createWorkArea({ shell });
  const older = wa.refresh([1]);
  const newer = wa.refresh([1]);
  assert.equal(calls.length, 2);
  calls[1].resolve(RECT);
  assert.equal(await newer, true);
  calls[0].resolve(null); // arrives late: must not overwrite
  assert.equal(await older, false);
  assert.deepEqual(wa.get(1), RECT);
});