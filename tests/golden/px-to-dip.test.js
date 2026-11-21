'use strict';

// pxToDip (linux/x11.js) pinned as a table before the conversion moves to core/geometry.js:
// every scale factor in use, negative display origins, the border between two monitors, and
// the fallback when the rect's centre is on no display.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pxToDip } = require('../../src/main/linux/x11');

const d = (x, y, width, height, scaleFactor) => ({ bounds: { x, y, width, height }, scaleFactor });
const MIXED = [d(0, 0, 1920, 1080, 1), d(1920, 0, 1280, 720, 1.5)]; // second: px x=2880, w=1920

// [name, displays, rect (X px), expected (DIP)]
const TABLE = [
  ['100%: identity', [d(0, 0, 1920, 1080, 1)], { x: 100, y: 80, w: 800, h: 600 }, { x: 100, y: 80, width: 800, height: 600 }],
  ['125%', [d(0, 0, 1536, 864, 1.25)], { x: 250, y: 125, w: 500, h: 250 }, { x: 200, y: 100, width: 400, height: 200 }],
  ['150%', [d(0, 0, 1280, 720, 1.5)], { x: 300, y: 150, w: 900, h: 600 }, { x: 200, y: 100, width: 600, height: 400 }],
  ['200%', [d(0, 0, 1280, 720, 2)], { x: 200, y: 100, w: 800, h: 600 }, { x: 100, y: 50, width: 400, height: 300 }],
  ['negative origin at 200%', [d(-1280, -720, 1280, 720, 2)], { x: -2000, y: -1000, w: 800, h: 600 }, { x: -1000, y: -500, width: 400, height: 300 }],
  ['two monitors, the rect on the second', [d(0, 0, 1920, 1080, 1), d(1920, 0, 2560, 1440, 1)], { x: 2000, y: 40, w: 600, h: 400 }, { x: 2000, y: 40, width: 600, height: 400 }],
  ['second monitor at 150%', MIXED, { x: 3000, y: 150, w: 900, h: 600 }, { x: 2000, y: 100, width: 600, height: 400 }],
  ['centre exactly on the second monitor\'s left edge goes to it', MIXED, { x: 2730, y: 150, w: 300, h: 600 }, { x: 1820, y: 100, width: 200, height: 400 }],
  ['centre in the gap between scaled monitors: the first display converts', MIXED, { x: 1900, y: 100, w: 200, h: 100 }, { x: 1900, y: 100, width: 200, height: 100 }],
  ['centre on no display at all: the first display converts', [d(0, 0, 1280, 720, 2)], { x: 5000, y: 5000, w: 400, h: 400 }, { x: 2500, y: 2500, width: 200, height: 200 }],
  ['no displays: the rect as it is', [], { x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, width: 3, height: 4 }],
];

test('pxToDip: the golden table', () => {
  for (const [name, displays, rect, want] of TABLE) {
    assert.deepEqual(pxToDip(rect, displays), want, name);
  }
});