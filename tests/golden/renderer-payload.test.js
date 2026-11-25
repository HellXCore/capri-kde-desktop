'use strict';

// The renderer's windows:update payload, pinned: the frame feed + toRendererPayload must produce
// exactly what the old feed (windows.js createFeed, wrapped by the shell with `self`) produced
// for the same snapshot. A failure here means the renderer contract changed — decide that on
// purpose, do not just edit the expectation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrameFeed, toRendererPayload } = require('../../src/main/platform/shell/frames');

// The old feed's send(), verbatim in behaviour: its toDip returned Electron-shaped rects,
// the shell attached the confirmed place as `self` afterwards.
function legacyPayload(snapshot, bounds, toDip, self = null) {
  const wins = snapshot.wins
    .map((w) => {
      const dip = toDip(w);
      return { id: w.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: w.max };
    })
    .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
  return {
    fg: snapshot.fg, taskbar: Boolean(snapshot.taskbar), ai: Array.isArray(snapshot.ai) ? snapshot.ai : [],
    game: snapshot.game || null, usb: Array.isArray(snapshot.usb) ? snapshot.usb : [], plug: snapshot.plug || null,
    wins, self,
  };
}

// The new path: the adapter converts the snapshot to DIPs before the feed (simulated here by
// `dip`); the feed frames it, devices captured from the facts channel.
function project(snapshot, bounds, { dip, self = null }) {
  let devices = { usb: [], plug: null };
  const feed = createFrameFeed({
    self: () => self,
    onFrame: () => {},
    onFact: (f) => { devices = { usb: f.usb, plug: f.plug }; },
  });
  feed.push({ ...snapshot, wins: snapshot.wins.map((w) => ({ ...w, ...dip(w) })) });
  return toRendererPayload(feed.last(), bounds, devices);
}

const ID_LEGACY = (w) => ({ x: w.x, y: w.y, width: w.w, height: w.h });
const ID_DIP = (r) => ({ ...r });
const HALF_LEGACY = (w) => ({ x: w.x / 2, y: w.y / 2, width: w.w / 2, height: w.h / 2 });
const HALF_DIP = (r) => ({ x: r.x / 2, y: r.y / 2, w: r.w / 2, h: r.h / 2 });

const KWIN_SNAP = {
  fg: 7, taskbar: false, ai: ['chatgpt'], game: 'Night City',
  usb: ['STICK'], plug: { n: 1, in: true, name: 'STICK', class: 'DiskDrive' },
  self: { x: 100, y: 50, w: 800, h: 600 },
  wins: [
    { id: 7, x: 150, y: 120, w: 400, h: 300, max: false },
    { id: 8, x: 2000, y: 50, w: 100, h: 100, max: false },
  ],
};
const KWIN_BOUNDS = { x: 100, y: 50, width: 800, height: 600 };

// The pinned message itself (the golden).
const KWIN_PAYLOAD = {
  fg: 7, taskbar: false, ai: ['chatgpt'], game: 'Night City',
  usb: ['STICK'], plug: { n: 1, in: true, name: 'STICK', class: 'DiskDrive' },
  wins: [{ id: 7, x: 50, y: 70, w: 400, h: 300, max: false }],
  self: { x: 100, y: 50, w: 800, h: 600 },
};

const CASES = [
  ['kwin native: dip units, self, devices, a window on another screen', KWIN_SNAP, KWIN_BOUNDS, ID_LEGACY, ID_DIP, KWIN_SNAP.self],
  ['x11: physical pixels halved, a panel in front, no self', {
    fg: 5, taskbar: true, ai: [], game: null, usb: [], plug: null,
    wins: [{ id: 5, x: 400, y: 200, w: 600, h: 400, max: false }, { id: 6, x: 4000, y: 0, w: 400, h: 400, max: false }],
  }, { x: 100, y: 0, width: 800, height: 600 }, HALF_LEGACY, HALF_DIP, null],
  ['an empty desktop', { fg: 0, taskbar: false, ai: [], game: null, usb: [], plug: null, wins: [] },
    { x: 0, y: 0, width: 1920, height: 1080 }, ID_LEGACY, ID_DIP, null],
  ['a maximized window covering the screen', {
    fg: 9, taskbar: false, ai: [], game: null, usb: [], plug: null,
    wins: [{ id: 9, x: 0, y: 40, w: 1920, h: 1040, max: true }],
  }, { x: 0, y: 0, width: 1920, height: 1080 }, ID_LEGACY, ID_DIP, null],
];

test('the payload equals the old feed on every case', () => {
  for (const [name, snapshot, bounds, legacyDip, dip, self] of CASES) {
    assert.deepEqual(project(snapshot, bounds, { dip, self }), legacyPayload(snapshot, bounds, legacyDip, self), name);
  }
});

test('the pinned payload (golden)', () => {
  assert.deepEqual(project(KWIN_SNAP, KWIN_BOUNDS, { dip: ID_DIP, self: KWIN_SNAP.self }), KWIN_PAYLOAD);
});

test('a device-only change: the same frame revision, the payload carries the new devices', () => {
  let devices = { usb: [], plug: null };
  const frames = [];
  const feed = createFrameFeed({
    self: () => KWIN_SNAP.self,
    onFrame: (f) => frames.push(f),
    onFact: (f) => { devices = { usb: f.usb, plug: f.plug }; },
  });
  const before = { ...KWIN_SNAP, usb: [], plug: null };
  feed.push(before);
  feed.push(KWIN_SNAP); // only the devices differ
  assert.equal(frames.length, 1);
  assert.deepEqual(toRendererPayload(feed.last(), KWIN_BOUNDS, devices), legacyPayload(KWIN_SNAP, KWIN_BOUNDS, ID_LEGACY, KWIN_SNAP.self));
});

test('the overlay moved: the same frame re-projected from the new place', () => {
  const feed = createFrameFeed({ self: () => KWIN_SNAP.self, onFrame: () => {} });
  feed.push(KWIN_SNAP);
  const moved = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(
    toRendererPayload(feed.last(), moved, { usb: KWIN_SNAP.usb, plug: KWIN_SNAP.plug }),
    legacyPayload(KWIN_SNAP, moved, ID_LEGACY, KWIN_SNAP.self),
  );
});