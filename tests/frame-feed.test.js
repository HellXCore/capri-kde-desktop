'use strict';

// The frame feed (platform/shell/frames.js): DIP adapter snapshots become WindowsFrame with a
// revision that grows on change; devices report on their own channel; the renderer payload is
// a projection (toRendererPayload) — the only place local coordinates are made.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrameFeed, toRendererPayload } = require('../src/main/platform/shell/frames');

const snap = (over = {}) => ({
  fg: 7, taskbar: false, ai: [], game: null, usb: [], plug: null,
  wins: [{ id: 7, x: 100, y: 50, w: 400, h: 300, max: false }],
  ...over,
});

function make(over = {}) {
  const frames = [];
  const facts = [];
  const feed = createFrameFeed({
    onFrame: (f) => frames.push(f),
    onFact: (f) => facts.push(f),
    ...over,
  });
  return { feed, frames, facts };
}

test('first snapshot: a typed frame at rev 1, global DIPs, no filtering', () => {
  const m = make({ self: () => ({ x: 10, y: 20, w: 800, h: 600 }) });
  m.feed.push(snap({
    wins: [
      { id: 7, x: 100, y: 50, w: 400, h: 300, max: false },
      { id: 8, x: 5000, y: 0, w: 100, h: 100, max: true },
    ],
  }));
  assert.equal(m.frames.length, 1);
  assert.deepEqual(m.frames[0], {
    rev: 1, fg: 7, dock: false, front: { ai: [], game: null },
    wins: [
      { id: 7, rect: { x: 100, y: 50, w: 400, h: 300 }, max: false },
      { id: 8, rect: { x: 5000, y: 0, w: 100, h: 100 }, max: true },
    ],
    self: { x: 10, y: 20, w: 800, h: 600 },
  });
  assert.deepEqual(m.facts, []); // empty devices: nothing to report
  assert.equal(m.feed.last(), m.frames[0]);
});

test('the same picture again: no new revision; a moved window: rev 2', () => {
  const m = make();
  m.feed.push(snap());
  m.feed.push(snap());
  assert.equal(m.frames.length, 1);
  m.feed.push(snap({ wins: [{ id: 7, x: 101, y: 50, w: 400, h: 300, max: false }] }));
  assert.equal(m.frames.length, 2);
  assert.equal(m.frames[1].rev, 2);
});

test('devices only: a fact, the revision holds; a rebuilt identical plug is not news', () => {
  const m = make();
  const plug = { n: 1, in: true, name: 'Stick', class: 'DiskDrive' };
  m.feed.push(snap());
  m.feed.push(snap({ usb: ['STICK'], plug }));
  assert.equal(m.frames.length, 1); // the desktop did not change
  assert.deepEqual(m.facts, [{ kind: 'devices', usb: ['STICK'], plug }]);
  m.feed.push(snap({ usb: ['STICK'], plug: { ...plug } })); // rebuilt object, same event
  assert.equal(m.facts.length, 1);
  m.feed.push(snap({ usb: [], plug: null })); // unplugged
  assert.equal(m.facts.length, 2);
  assert.deepEqual(m.facts[1], { kind: 'devices', usb: [], plug: null });
});

test('front (ai, game), dock and self are part of the picture: they bump the revision', () => {
  const m = make({ self: (s) => s.self || null });
  m.feed.push(snap());
  m.feed.push(snap({ ai: ['chatgpt'] }));
  m.feed.push(snap({ ai: ['chatgpt'], game: 'Night City' }));
  m.feed.push(snap({ ai: ['chatgpt'], game: 'Night City', taskbar: true }));
  m.feed.push(snap({ ai: ['chatgpt'], game: 'Night City', taskbar: true, self: { x: 1, y: 2, w: 3, h: 4 } }));
  assert.deepEqual(m.frames.map((f) => f.rev), [1, 2, 3, 4, 5]);
  assert.deepEqual(m.facts, []);
});

test('resend: the same frame at the same revision; before the first snapshot: nothing', () => {
  const m = make();
  m.feed.resend();
  assert.equal(m.frames.length, 0);
  m.feed.push(snap());
  m.feed.resend();
  assert.equal(m.frames.length, 2);
  assert.equal(m.frames[1], m.frames[0]); // the very same picture, not a new one
  assert.equal(m.frames[1].rev, 1);
});

test('devices are reported before the frame, so the first payload already carries them', () => {
  const order = [];
  const feed = createFrameFeed({
    toDip: (r) => ({ ...r }),
    onFrame: () => order.push('frame'),
    onFact: () => order.push('fact'),
  });
  feed.push(snap({ usb: ['STICK'] }));
  assert.deepEqual(order, ['fact', 'frame']);
});

test('DIP rects pass through as they are, fractions kept: the conversion is the adapter\'s', () => {
  const m = make();
  m.feed.push(snap({ wins: [{ id: 7, x: 100.5, y: 50.25, w: 400.5, h: 300.25, max: false }] }));
  assert.deepEqual(m.frames[0].wins[0].rect, { x: 100.5, y: 50.25, w: 400.5, h: 300.25 });
});

test('change detection never serialises: push and resend work with JSON.stringify broken', (t) => {
  const m = make();
  t.mock.method(JSON, 'stringify', () => { throw new Error('no serialising in the feed'); });
  m.feed.push(snap());
  m.feed.push(snap());
  m.feed.push(snap({ usb: ['STICK'] }));
  m.feed.push(snap({ usb: ['STICK'], wins: [{ id: 7, x: 101, y: 50, w: 400, h: 300, max: false }] }));
  m.feed.resend();
  assert.deepEqual(m.frames.map((f) => f.rev), [1, 2, 2]);
  assert.equal(m.facts.length, 1);
});

// ---------- the renderer projection ----------

const BOUNDS = { x: 100, y: 50, width: 800, height: 600 };

test('toRendererPayload: local coordinates, only what overlaps the overlay, devices merged', () => {
  const frame = {
    rev: 3, fg: 7, dock: true, front: { ai: ['chatgpt'], game: 'Night City' },
    wins: [
      { id: 7, rect: { x: 150, y: 120, w: 400, h: 300 }, max: false },
      { id: 8, rect: { x: 5000, y: 0, w: 100, h: 100 }, max: false },  // another screen: left out
      { id: 9, rect: { x: 850, y: 100, w: 200, h: 200 }, max: true },  // partially on screen: kept
    ],
    self: { x: 100, y: 50, w: 800, h: 600 },
  };
  const devices = { usb: ['STICK'], plug: { n: 1, in: true, name: 'Stick', class: 'DiskDrive' } };
  assert.deepEqual(toRendererPayload(frame, BOUNDS, devices), {
    fg: 7, taskbar: true, ai: ['chatgpt'], game: 'Night City',
    usb: ['STICK'], plug: { n: 1, in: true, name: 'Stick', class: 'DiskDrive' },
    wins: [
      { id: 7, x: 50, y: 70, w: 400, h: 300, max: false },
      { id: 9, x: 750, y: 50, w: 200, h: 200, max: true },
    ],
    self: { x: 100, y: 50, w: 800, h: 600 },
  });
});

test('toRendererPayload: no devices said: empty defaults; no self: null', () => {
  const frame = { rev: 1, fg: 0, dock: false, front: { ai: [], game: null }, wins: [], self: null };
  assert.deepEqual(toRendererPayload(frame, BOUNDS), {
    fg: 0, taskbar: false, ai: [], game: null, usb: [], plug: null, wins: [], self: null,
  });
});