'use strict';

// core/geometry.js: the three coordinate spaces and the two conversions between global DIPs
// and X pixels. The tables pin the numbers the legacy watcher's conversion is pinned by
// (tests/golden/px-to-dip.test.js), in the canonical {x,y,w,h} shape over DisplayInfo. The
// property tests are the acceptance: dipToPx(pxToDip(r)) is r within a pixel, at every scale
// in use, with negative origins and a rect on the border of two monitors.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toLocal, intersects, contains, pxToDip, dipToPx } = require('../src/main/core/geometry');

// A full DisplayInfo; geometry reads bounds and scale only.
let nextId = 1;
const d = (x, y, w, h, scale) => ({
  id: nextId++,
  bounds: { x, y, w, h },
  workArea: { x, y, w, h: h - 40 },
  scale,
});
// Two monitors: 1920x1080 at 100 %, then 1280x720 DIP at 150 % (its pixels start at x=2880).
const MIXED = () => [d(0, 0, 1920, 1080, 1), d(1920, 0, 1280, 720, 1.5)];

// ---------- toLocal, intersects, contains ----------

test('toLocal: the overlay origin subtracted, the size kept', () => {
  assert.deepEqual(
    toLocal({ x: 2100, y: 300, w: 400, h: 200 }, { x: 1920, y: 0, w: 2560, h: 1440 }),
    { x: 180, y: 300, w: 400, h: 200 },
  );
  assert.deepEqual(
    toLocal({ x: 10, y: 20, w: 30, h: 40 }, { x: -1920, y: -100, w: 1920, h: 1080 }),
    { x: 1930, y: 120, w: 30, h: 40 },
  );
  const r = { x: 5, y: 6, w: 7, h: 8 };
  assert.deepEqual(toLocal(r, { x: 0, y: 0, w: 1, h: 1 }), r);
});

test('intersects: overlap and containment count; touching, disjoint and empty do not', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(intersects(a, { x: 50, y: 50, w: 100, h: 100 }), true);
  assert.equal(intersects(a, { x: 10, y: 10, w: 20, h: 20 }), true);      // inside
  assert.equal(intersects(a, { x: -50, y: -50, w: 200, h: 200 }), true);  // around
  assert.equal(intersects(a, { x: 100, y: 0, w: 100, h: 100 }), false);   // touching right edge
  assert.equal(intersects(a, { x: 0, y: 100, w: 100, h: 100 }), false);   // touching bottom edge
  assert.equal(intersects(a, { x: 200, y: 200, w: 10, h: 10 }), false);
  assert.equal(intersects(a, { x: 50, y: 50, w: 0, h: 10 }), false);      // zero area
  assert.equal(intersects(a, { x: 50, y: 50, w: -10, h: 10 }), false);    // negative area
  assert.equal(intersects({ x: 0, y: 0, w: 0, h: 0 }, a), false);
});

test('contains: half-open — left and top edges are in, right and bottom are out', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  assert.equal(contains(r, { x: 10, y: 20 }), true);
  assert.equal(contains(r, { x: 109.999, y: 69.999 }), true);
  assert.equal(contains(r, { x: 110, y: 50 }), false); // right edge
  assert.equal(contains(r, { x: 50, y: 70 }), false);  // bottom edge
  assert.equal(contains(r, { x: 9, y: 30 }), false);
  assert.equal(contains({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0 }), false);
  // the border of two side-by-side displays belongs to exactly one of them
  const left = { x: 0, y: 0, w: 1920, h: 1080 };
  const right = { x: 1920, y: 0, w: 2560, h: 1440 };
  assert.equal(contains(left, { x: 1920, y: 100 }), false);
  assert.equal(contains(right, { x: 1920, y: 100 }), true);
});

// ---------- the conversion tables (the legacy numbers, in {x,y,w,h}) ----------

const PX_TABLE = [
  ['100%: identity', [d(0, 0, 1920, 1080, 1)], { x: 100, y: 80, w: 800, h: 600 }, { x: 100, y: 80, w: 800, h: 600 }],
  ['125%', [d(0, 0, 1536, 864, 1.25)], { x: 250, y: 125, w: 500, h: 250 }, { x: 200, y: 100, w: 400, h: 200 }],
  ['150%', [d(0, 0, 1280, 720, 1.5)], { x: 300, y: 150, w: 900, h: 600 }, { x: 200, y: 100, w: 600, h: 400 }],
  ['200%', [d(0, 0, 1280, 720, 2)], { x: 200, y: 100, w: 800, h: 600 }, { x: 100, y: 50, w: 400, h: 300 }],
  ['negative origin at 200%', [d(-1280, -720, 1280, 720, 2)], { x: -2000, y: -1000, w: 800, h: 600 }, { x: -1000, y: -500, w: 400, h: 300 }],
  ['two monitors, the rect on the second', [d(0, 0, 1920, 1080, 1), d(1920, 0, 2560, 1440, 1)], { x: 2000, y: 40, w: 600, h: 400 }, { x: 2000, y: 40, w: 600, h: 400 }],
  ['second monitor at 150%', MIXED(), { x: 3000, y: 150, w: 900, h: 600 }, { x: 2000, y: 100, w: 600, h: 400 }],
  ['centre exactly on the second monitor\'s left edge goes to it', MIXED(), { x: 2730, y: 150, w: 300, h: 600 }, { x: 1820, y: 100, w: 200, h: 400 }],
  ['centre in the gap between scaled monitors: the first display converts', MIXED(), { x: 1900, y: 100, w: 200, h: 100 }, { x: 1900, y: 100, w: 200, h: 100 }],
  ['centre on no display at all: the first display converts', [d(0, 0, 1280, 720, 2)], { x: 5000, y: 5000, w: 400, h: 400 }, { x: 2500, y: 2500, w: 200, h: 200 }],
  ['a zero scale reads as 1', [d(0, 0, 1920, 1080, 0)], { x: 100, y: 80, w: 800, h: 600 }, { x: 100, y: 80, w: 800, h: 600 }],
  ['no displays: the rect as it is', [], { x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 }],
];

test('pxToDip: the pinned table', () => {
  for (const [name, displays, rect, want] of PX_TABLE) {
    assert.deepEqual(pxToDip(rect, displays), want, name);
  }
});

const DIP_TABLE = [
  ['100%: identity', [d(0, 0, 1920, 1080, 1)], { x: 100, y: 80, w: 800, h: 600 }, { x: 100, y: 80, w: 800, h: 600 }],
  ['125%', [d(0, 0, 1536, 864, 1.25)], { x: 200, y: 100, w: 400, h: 200 }, { x: 250, y: 125, w: 500, h: 250 }],
  ['200%', [d(0, 0, 1280, 720, 2)], { x: 100, y: 50, w: 400, h: 300 }, { x: 200, y: 100, w: 800, h: 600 }],
  ['negative origin at 200%', [d(-1280, -720, 1280, 720, 2)], { x: -1000, y: -500, w: 400, h: 300 }, { x: -2000, y: -1000, w: 800, h: 600 }],
  ['second monitor at 150%', MIXED(), { x: 2000, y: 100, w: 600, h: 400 }, { x: 3000, y: 150, w: 900, h: 600 }],
  ['centre on the shared DIP edge goes to the second display', MIXED(), { x: 1820, y: 100, w: 200, h: 400 }, { x: 2730, y: 150, w: 300, h: 600 }],
  ['centre on no display: the first display converts', [d(0, 0, 1280, 720, 2)], { x: 5000, y: 5000, w: 400, h: 400 }, { x: 10000, y: 10000, w: 800, h: 800 }],
  ['no displays: the rect as it is', [], { x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 }],
];

test('dipToPx: the pinned table (the inverse readings)', () => {
  for (const [name, displays, rect, want] of DIP_TABLE) {
    assert.deepEqual(dipToPx(rect, displays), want, name);
  }
});

test('the gap between differently scaled monitors: each direction picks on its own side', () => {
  const displays = MIXED();
  const px = { x: 1900, y: 100, w: 200, h: 100 }; // its pixel centre lies in the gap
  const dip = pxToDip(px, displays);
  assert.deepEqual(dip, px); // no pixel rect holds it: the first display (scale 1) converts
  // the same numbers read as DIPs are inside the second monitor: the direction matters,
  // which is why the round-trip property is stated for centres a monitor holds
  assert.deepEqual(dipToPx(dip, displays), { x: 2850, y: 150, w: 300, h: 150 });
});

test('conversions return fresh rects and never touch their inputs', () => {
  const r = Object.freeze({ x: 250, y: 125, w: 500, h: 250 });
  const displays = [d(0, 0, 1536, 864, 1.25)];
  const dip = pxToDip(r, displays);
  assert.deepEqual(dip, { x: 200, y: 100, w: 400, h: 200 });
  assert.notEqual(dip, r);
  assert.notEqual(dipToPx(dip, displays), dip);
  const passthrough = pxToDip(r, []);
  assert.deepEqual(passthrough, r);
  assert.notEqual(passthrough, r);
});

// ---------- the property: dipToPx(pxToDip(r)) ≈ r, within 1 px ----------

// A deterministic PRNG: the same seed replays the same rects.
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const within1px = (got, want, what) => {
  for (const k of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(got[k] - want[k]) <= 1, `${what}: ${k} ${got[k]} vs ${want[k]} (±1 px)`);
  }
};

test('property: round trip at 100/125/150/200 %, negative origins', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const rand = rng(Math.round(scale * 1000));
    for (let i = 0; i < 250; i++) {
      const ox = -Math.floor(rand() * 4000);
      const oy = -Math.floor(rand() * 2000);
      const displays = [d(ox, oy, 1920, 1080, scale)];
      const r = {
        x: ox + Math.floor(rand() * 6000) - 1000,
        y: oy + Math.floor(rand() * 3000) - 500,
        w: 1 + Math.floor(rand() * 2500),
        h: 1 + Math.floor(rand() * 1500),
      };
      within1px(dipToPx(pxToDip(r, displays), displays), r, `scale ${scale}, rect ${i}`);
    }
  }
});

test('property: a rect on the border of two monitors round-trips', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const rand = rng(7919 * Math.round(scale * 100));
    const ox = -Math.floor(rand() * 3000);
    const displays = [d(ox, 0, 1920, 1080, scale), d(ox + 1920, 0, 2560, 1440, scale)];
    const border = (ox + 1920) * scale; // the shared edge, in X pixels
    for (let i = 0; i < 250; i++) {
      const w = 2 + Math.floor(rand() * 1600);
      const h = 2 + Math.floor(rand() * 900);
      const cx = border + Math.floor(rand() * 161) - 80; // the centre within ±80 px of the edge
      const r = { x: cx - w / 2, y: Math.floor(rand() * 800), w, h };
      within1px(dipToPx(pxToDip(r, displays), displays), r, `scale ${scale}, border rect ${i}`);
    }
    // the centre exactly on the edge: the right-hand monitor owns it, in both directions
    const onEdge = { x: border - 300, y: 10, w: 600, h: 400 };
    within1px(dipToPx(pxToDip(onEdge, displays), displays), onEdge, `scale ${scale}, exactly on the edge`);
  }
});

test('property: mixed scales, a centre inside a monitor round-trips', () => {
  for (const [s1, s2] of [[1, 1.5], [1.25, 2], [2, 1], [1.5, 1.25]]) {
    const rand = rng(Math.round(s1 * 100) * 31 + Math.round(s2 * 100));
    // the shared DIP edge at x=0 is a shared pixel edge at any scales: no gap, no overlap
    const displays = [d(-1920, -200, 1920, 1080, s1), d(0, 0, 1280, 720, s2)];
    for (let i = 0; i < 250; i++) {
      const pick = displays[rand() < 0.5 ? 0 : 1];
      const s = pick.scale;
      const px = { x: pick.bounds.x * s, y: pick.bounds.y * s, w: pick.bounds.w * s, h: pick.bounds.h * s };
      const w = 2 + Math.floor(rand() * 800);
      const h = 2 + Math.floor(rand() * 500);
      const r = {
        x: px.x + 1 + rand() * (px.w - 2) - w / 2, // the centre strictly inside this monitor
        y: px.y + 1 + rand() * (px.h - 2) - h / 2,
        w, h,
      };
      within1px(dipToPx(pxToDip(r, displays), displays), r, `${s1}/${s2}, rect ${i}`);
    }
  }
});