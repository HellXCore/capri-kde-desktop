'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fromPayload, toXPixels, startKWinWatch, writeScript, windowsOf, parseCursor, parseMove, applyMove, SCRIPT_NAME,
} = require('../src/main/linux/kwin-bridge');

const win = (types = [], state = []) => ({ types, state, desktop: null, pid: 1 });
const payload = () => ({
  v: 1,
  root: { active: 10, stacking: [10, 11, 12, 13, 14], desktop: null }, // front first
  infos: {
    10: win(),                    // a normal window: a seat
    11: win(['DOCK']),            // a panel: not a seat
    12: win(),                    // too small
    13: win([], ['HIDDEN']),      // minimized
    14: win([], ['MAXIMIZED_VERT', 'MAXIMIZED_HORZ']),
  },
  rects: {
    10: { x: 100, y: 80, w: 800, h: 600 },
    11: { x: 0, y: 0, w: 1920, h: 40 },
    12: { x: 5, y: 5, w: 100, h: 50 },
    13: { x: 0, y: 0, w: 800, h: 600 },
    14: { x: 0, y: 40, w: 1920, h: 1040 },
  },
  outputs: [{ x: 0, y: 0, w: 1920, h: 1080, s: 1 }],
  ai: ['chatgpt', 5],
});
// KWin keeps the compiled QML of a path it has loaded, and the engine also caches the directory it
// loaded from: a file created in it afterwards fails its exact-name check ("File name case mismatch")
// until KWin restarts. One directory per build, a fixed name inside it — these tests hold that.
const scratch = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-kwin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sourceWith = (t, text) => {
  const file = path.join(scratch(t), 'src.qml');
  fs.writeFileSync(file, text);
  return file;
};

test('kwin payload: seats in the Windows helper format, front first, others left out', () => {
  const snap = fromPayload(payload());
  assert.equal(snap.fg, 10);
  assert.deepEqual(snap.wins, [
    { id: 10, x: 100, y: 80, w: 800, h: 600, max: false },
    { id: 14, x: 0, y: 40, w: 1920, h: 1040, max: true },
  ]);
  assert.deepEqual(snap.ai, ['chatgpt']); // keys only, anything but a string dropped
  assert.equal(snap.game, null);
  assert.deepEqual(snap.usb, []);
});

test('kwin payload: a panel in front is reported as the taskbar', () => {
  const p = payload();
  p.root.active = 11;
  assert.equal(fromPayload(p).taskbar, true);
});

test('kwin payload: anything that is not version 1 is refused, garbage is dropped', () => {
  assert.throws(() => fromPayload(null), /unknown payload/);
  assert.throws(() => fromPayload({ v: 2 }), /unknown payload/);
  const p = payload();
  p.rects[10] = { x: 'a', y: 0, w: 800, h: 600 }; // not numbers: no rectangle, no window
  p.infos.oops = 'x';
  assert.equal(fromPayload(p).wins.some((w) => w.id === 10), false);
});

test('kwin units: logical pixels as they are, physical ones scaled by the output holding the centre', () => {
  const rect = { x: 100, y: 100, w: 400, h: 300 };
  const outputs = [{ x: 0, y: 0, w: 1920, h: 1080, s: 2 }];
  assert.deepEqual(toXPixels(rect, outputs, 'logical'), rect);
  assert.deepEqual(toXPixels(rect, outputs, 'physical'), { x: 200, y: 200, w: 800, h: 600 });
  assert.deepEqual(toXPixels(rect, [], 'physical'), rect); // no output known: scale 1
});

test('kwin watch: off outside a KDE Wayland session, no bus touched', () => {
  const before = process.env.XDG_CURRENT_DESKTOP;
  try {
    for (const [desktop, session] of [['GNOME', 'wayland'], ['KDE', 'x11'], ['KDE', null]]) {
      process.env.XDG_CURRENT_DESKTOP = desktop;
      const states = [];
      const logs = [];
      const watch = startKWinWatch({ session, scriptDir: '/nonexistent', onSnapshot() {}, onState: (ok) => states.push(ok), log: { log: (m) => logs.push(m), error() {} } });
      assert.deepEqual(states, [false], `${desktop} / ${session}`);
      assert.match(logs[0], /kwin watch: off/);
      watch.stop(); // a no-op, must not throw
    }
  } finally {
    if (before === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = before;
  }
});

// ---------- the script on disk ----------
test('kwin script: one directory per build, a fixed name inside, the build told to the script', (t) => {
  const dir = path.join(scratch(t), 'kwin');
  const source = sourceWith(t, 'Item { property string build: "@BUILD@" }\n');
  const a = writeScript(dir, source);
  assert.equal(path.basename(a.file), `${SCRIPT_NAME}.qml`);
  assert.equal(path.basename(path.dirname(a.file)), a.build);
  const written = fs.readFileSync(a.file, 'utf8');
  assert.equal(written.includes('"@BUILD@"'), false, 'the placeholder was left in the script');
  assert.ok(written.includes(`"${a.build}"`));

  // a changed text: a new directory, and the old one is gone (nothing was loaded from it here)
  fs.writeFileSync(source, 'Item { property string build: "@BUILD@"; property int x: 1 }\n');
  const b = writeScript(dir, source);
  assert.notEqual(b.build, a.build);
  assert.ok(fs.existsSync(b.file));
  assert.equal(fs.existsSync(a.file), false);

  // the same text again: the same path (it is the same script, KWin may have it cached)
  assert.equal(writeScript(dir, source).file, b.file);
});

test('kwin script: the flat hash-named files of the old scheme are cleaned up, nothing else is', (t) => {
  const dir = path.join(scratch(t), 'kwin');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = ['capri-windows.qml', 'capri-windows-deadbeef.qml'].map((f) => path.join(dir, f));
  for (const f of legacy) fs.writeFileSync(f, 'Item {}');
  const keep = path.join(dir, 'notes.txt');
  fs.writeFileSync(keep, 'not ours');
  writeScript(dir, sourceWith(t, 'Item { property string build: "@BUILD@" }\n'));
  for (const f of legacy) assert.equal(fs.existsSync(f), false, `${path.basename(f)} was left behind`);
  assert.ok(fs.existsSync(keep));
});

// ---------- the rest of what the receiver reads ----------
test('kwin windows: the list of open apps keeps its shape, garbage is dropped', () => {
  const found = windowsOf({ infos: {
    10: { pid: 5, cls: 'org.kde.konsole', app: 'org.kde.konsole.desktop', types: ['NORMAL'], state: [] },
    11: { pid: 'x', cls: null, app: null, types: 'no', state: null },
    oops: 'not a window',
  } });
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { id: 10, pid: 5, cls: 'org.kde.konsole', app: 'org.kde.konsole.desktop', types: ['NORMAL'], state: [] });
  assert.deepEqual(found[1], { id: 11, pid: null, cls: '', app: '', types: [], state: [] });
});

test('kwin cursor: global point, and the same point from her own corner', () => {
  assert.deepEqual(parseCursor('123,456'), { x: 123, y: 456 });
  assert.deepEqual(parseCursor('-10,-20,30,40'), { x: -10, y: -20, rel: { x: 30, y: 40 } });
  for (const bad of ['', '1,2,3', 'a,b', '1,2,3,4,5', '1234567,1']) assert.equal(parseCursor(bad), null, bad);
});

test('kwin move: the light channel, and what it changes in the snapshot', () => {
  assert.deepEqual(parseMove('10,-5,6,800,600'), { id: 10, x: -5, y: 6, w: 800, h: 600 });
  assert.equal(parseMove('10,0,0,0,600'), null); // no rectangle
  assert.equal(parseMove('nope'), null);
  const snap = fromPayload(payload());
  const moved = applyMove(snap, { id: 10, x: 5, y: 6, w: 800, h: 600 }, [], 'logical');
  assert.deepEqual(moved.wins.find((w) => w.id === 10), { id: 10, x: 5, y: 6, w: 800, h: 600, max: false });
  assert.equal(applyMove(snap, { id: 10, x: 100, y: 80, w: 800, h: 600 }, [], 'logical'), null); // it did not move
  assert.equal(applyMove(snap, { id: 99, x: 0, y: 0, w: 10, h: 10 }, [], 'logical'), null);      // not in the list
});