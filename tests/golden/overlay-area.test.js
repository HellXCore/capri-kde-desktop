'use strict';

// overlayArea's computation, pinned: with no answer from the port (null — all LegacyShell ever
// says) it is exactly the old formula over Electron's display facts, for every rest mode; with an
// answer, the platform's work area is used and the gap measured against it. The wiring in main.js
// is pinned too: it asks the port and delegates the computation. A failure here means behaviour
// changed — decide that on purpose, do not just edit the expectation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { overlayAreaFor } = require('../../src/main/platform/shell/work-area');

// The old overlayArea (main.js), verbatim in behaviour.
function legacyArea(display, rest) {
  const { workArea, bounds } = display;
  const area = rest === 'taskbar' ? { ...bounds, y: bounds.y + 1, height: bounds.height - 1 } : workArea;
  return { area, gap: area.y + area.height - (workArea.y + workArea.height) };
}

const DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, workArea: { x: 1920, y: -200, width: 2560, height: 1400 } },
  { id: 3, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 30, width: 1280, height: 690 } },
  { id: 4, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }, // no panel
];

test('null from the port: the old formula on every display and rest mode', () => {
  for (const d of DISPLAYS) {
    for (const rest of ['corner', 'taskbar', undefined]) {
      assert.deepEqual(overlayAreaFor(d, rest, null), legacyArea(d, rest), `display ${d.id}, rest ${rest}`);
    }
  }
});

test('a known work area is used, and the gap is measured against it', () => {
  const d = DISPLAYS[0];
  const known = { x: 0, y: 0, w: 1920, h: 1000 }; // the platform sees an 80 px panel Chromium does not
  assert.deepEqual(overlayAreaFor(d, 'corner', known), {
    area: { x: 0, y: 0, width: 1920, height: 1000 }, gap: 0,
  });
  assert.deepEqual(overlayAreaFor(d, 'taskbar', known), {
    area: { x: 0, y: 1, width: 1920, height: 1079 }, gap: 80,
  });
});

test('the inputs are never touched', () => {
  const d = Object.freeze({
    id: 1,
    bounds: Object.freeze({ ...DISPLAYS[0].bounds }),
    workArea: Object.freeze({ ...DISPLAYS[0].workArea }),
  });
  const known = Object.freeze({ x: 0, y: 32, w: 1920, h: 1048 });
  overlayAreaFor(d, 'taskbar', known);
  overlayAreaFor(d, 'corner', null);
  assert.deepEqual(d.bounds, DISPLAYS[0].bounds);
  assert.deepEqual(known, { x: 0, y: 32, w: 1920, h: 1048 });
});

test('main.js takes the area from the port, and asks it again when up or the displays change', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/platform\/shell\/work-area['"]\)/);
  assert.match(src, /createWorkArea\(\{ shell: desktopShell \}\)/);
  const at = src.indexOf('function overlayArea()');
  assert.ok(at >= 0);
  const fn = src.slice(at, src.indexOf('\n}', at));
  assert.match(fn, /overlayAreaFor\(display, config\.load\(\)\.rest, workAreas\?\.get\(display\.id\) \?\? null\)/);
  assert.doesNotMatch(fn, /rest === 'taskbar'/); // the computation lives in the module now
  assert.match(src, /workAreas\.refresh\(displays\(\)\.map\(\(d\) => d\.id\)\)/);
  assert.match(src, /if \(h\.state !== 'ready'\) return;\s*\n\s*refreshWorkAreas\(\);/);
  const screens = src.slice(src.indexOf('const screensChanged'));
  assert.match(screens.slice(0, screens.indexOf('};')), /refreshWorkAreas\(\);/);
});