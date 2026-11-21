'use strict';

// The OverlayController on a FakeWindow and a FakeShell: placement confirmed (not polled), the
// input strategy picked from the capabilities, and the safety invariant — after ANY combination
// of overlay capabilities and ANY sequence of events, the window either ignores the mouse or the
// pointer is inside an interactive zone (the toggle's give-back grace is settled first).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOverlayController } = require('../src/main/app/overlay-window');
const { createFakeShell } = require('./fakes/fake-shell');
const { createFakeWindow } = require('./fakes/fake-window');
const { createFakeClock } = require('./fakes/fake-clock');
const { LEAVE_MS, PADDING } = require('../src/main/platform/input/toggle');
const { OFFSCREEN } = require('../src/main/platform/input/xshape-client');

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const silent = { log() {}, warn() {}, error() {} };

function make(capsPatch = {}, over = {}) {
  const clock = createFakeClock();
  const fake = createFakeShell();
  fake.setCaps(capsPatch);
  const made = [];
  const theme = new EventEmitter();
  const sizes = [];
  const rearms = [];
  let area = { ...AREA };
  const ctl = createOverlayController({
    BrowserWindow: function (opts) { const f = createFakeWindow(opts); made.push(f); return f.win; },
    shell: fake.shell,
    clock,
    log: silent,
    nativeTheme: theme,
    areaOf: () => ({ area, gap: 40 }),
    onResize: (s) => sizes.push(s),
    onRearm: () => rearms.push(1),
    defer: (fn) => clock.setTimeout(fn, 0),
    ...over,
  });
  const create = (opts = {}) => ctl.create({ preload: 'p', url: 'u', managed: false, title: 'capri-overlay', ...opts });
  return { ctl, fake, clock, theme, made, sizes, rearms, create, fw: () => made[0], setArea: (a) => { area = a; } };
}

// ---------- placement ----------

test('client place: setBounds once (deduped), confirmed after the settle delay', async () => {
  const m = make({ overlay: { place: 'client' } });
  m.create();
  const p1 = m.ctl.place(AREA);
  assert.equal(m.fw().count('setBounds'), 1);
  const p2 = m.ctl.place(AREA); // the same request again: not sent
  assert.equal(m.fw().count('setBounds'), 1);
  m.clock.advance(60);
  assert.deepEqual(await p1, AREA);
  assert.deepEqual(await p2, AREA);
});

test('compositor place: the shell request is awaited; a stall times out to the last confirmed place', async () => {
  const m = make({ overlay: { place: 'compositor' } });
  m.create();
  m.fake.emitFrame({ rev: 1, fg: 0, dock: false, front: { ai: [], game: null }, wins: [], self: { x: 5, y: 6, w: 800, h: 600 } });
  const release = m.fake.drive.stall();
  const p = m.ctl.place(AREA);
  assert.equal(m.fw().count('setBounds'), 1); // the Electron request still goes out
  m.clock.advance(1500);
  assert.deepEqual(await p, { x: 5, y: 6, width: 800, height: 600 }); // the compositor's last word
  release();
});

test('compositor place: a confirming shell resolves without the timeout', async () => {
  const m = make({ overlay: { place: 'compositor' } });
  m.create();
  const r = await m.ctl.place(AREA); // FakeShell confirms the requested rect
  assert.deepEqual(r, AREA);
  assert.equal(m.clock.pending, 0); // the timeout was dropped
});

test('bounds(): the compositor\'s confirmed place, else the window\'s own', () => {
  const m = make({ overlay: { place: 'compositor' } });
  m.create();
  assert.deepEqual(m.ctl.bounds(), AREA); // nothing confirmed yet: the window's answer
  m.fake.emitFrame({ rev: 1, fg: 0, dock: false, front: { ai: [], game: null }, wins: [], self: { x: 10, y: 20, w: 1280, h: 720 } });
  assert.deepEqual(m.ctl.bounds(), { x: 10, y: 20, width: 1280, height: 720 });
});

// ---------- stacking, keyboard, rearm ----------

test('raise: client says it twice (0 and 400 ms); compositor asks the shell', () => {
  const client = make({ overlay: { stacking: 'client' } });
  client.create();
  client.ctl.raise();
  client.clock.advance(0);
  assert.equal(client.fw().count('moveTop'), 1);
  client.clock.advance(400);
  assert.equal(client.fw().count('moveTop'), 2);
  const comp = make({ overlay: { stacking: 'compositor' } });
  comp.create();
  comp.ctl.raise();
  comp.clock.advance(1000);
  assert.equal(comp.fw().count('moveTop'), 0);
  assert.ok(comp.fake.journal.some((c) => c.op === 'overlay.raise'));
});

test('rearm: a managed window is made unfocusable again, unless her chat holds the keyboard', () => {
  const m = make({ overlay: { stacking: 'client', focus: 'compositor' } });
  m.create({ managed: true });
  m.ctl.rearm();
  assert.deepEqual(m.fw().calls.filter((c) => c.op === 'setFocusable').map((c) => c.args[0]), [false, false]);
  assert.equal(m.rearms.length, 1);
  assert.equal(m.sizes.length, 1); // fitted again
  m.ctl.focus(true);
  m.ctl.rearm();
  assert.equal(m.fw().last('setFocusable').args[0], true); // not taken back mid-chat
});

test('focus: focusable + the shell told + focus/blur, the input said again', () => {
  const m = make({ overlay: { input: 'toggle', focus: 'compositor' } });
  m.create({ managed: true });
  m.ctl.focus(true);
  assert.equal(m.fw().last('setFocusable').args[0], true);
  assert.equal(m.fw().count('focus'), 1);
  assert.deepEqual(m.fake.journal.filter((c) => c.op === 'overlay.focus').map((c) => c.args[0]), [true]);
  m.ctl.focus(false);
  assert.equal(m.fw().count('blur'), 1);
});

// ---------- the strategies ----------

test('passthrough: ignores the mouse from creation; zones, pointers and events never take it back', () => {
  const m = make({ overlay: { input: 'passthrough' } });
  m.create();
  m.ctl.setZones({ rects: [{ x: 0, y: 0, width: 100, height: 100 }], dpr: 1 });
  m.fake.emitPointer({ x: 10, y: 10 });
  m.fw().emit('resize');
  m.theme.emit('updated');
  m.clock.advance(1000);
  assert.deepEqual(m.fw().calls.filter((c) => c.op === 'setIgnoreMouseEvents').map((c) => c.args[0]), [true]);
  assert.equal(m.fw().count('setShape'), 0);
});

test('toggle: click-through until the pointer is over a zone; the give-back waits its grace', () => {
  const m = make({ overlay: { input: 'toggle' } });
  m.create();
  m.ctl.setZones({ rects: [{ x: 100, y: 100, width: 50, height: 50 }], dpr: 1 });
  m.fake.emitPointer({ x: 110, y: 110 });
  assert.equal(m.ctl.inputState().ignoring, false);
  m.fake.emitPointer({ x: 500, y: 500 });
  m.clock.advance(LEAVE_MS - 1);
  assert.equal(m.ctl.inputState().ignoring, false); // still hers for a moment
  m.clock.advance(1);
  assert.equal(m.ctl.inputState().ignoring, true);
});

test('xshape (bounding fallback): the shape is the zones in whole pixels; empty is nowhere', () => {
  const m = make({ overlay: { input: 'xshape' } });
  m.create();
  assert.deepEqual(m.fw().last('setShape').args[0], OFFSCREEN); // before anything is drawn
  m.ctl.setZones({ rects: [{ x: 10.4, y: 20.6, width: 30.5, height: 40.5 }, { x: 0, y: 0, width: 0, height: 10 }], dpr: 2 });
  assert.deepEqual(m.fw().last('setShape').args[0], [{ x: 10, y: 21, width: 31, height: 41 }]);
  assert.ok(m.fake.journal.some((c) => c.op === 'overlay.zones')); // the shell is told too
  m.ctl.setZones({ rects: [], dpr: 1 });
  assert.deepEqual(m.fw().last('setShape').args[0], OFFSCREEN);
});

test('invalidation: resize/show/theme coalesce into one reapply', () => {
  const m = make({ overlay: { input: 'toggle' } });
  m.create();
  m.ctl.setZones({ rects: [{ x: 0, y: 0, width: 10, height: 10 }], dpr: 1 });
  m.fake.emitPointer({ x: 5, y: 5 }); // taking the mouse
  const before = m.fw().count('invalidate');
  m.fw().emit('resize');
  m.fw().emit('show');
  m.theme.emit('updated');
  m.clock.advance(0);
  assert.equal(m.fw().count('invalidate') - before, 1);
});

test('ready-to-show: fitted, shown inactive, input said again, a managed window unfocused', () => {
  const m = make();
  m.create({ managed: true });
  m.fw().emit('ready-to-show');
  assert.equal(m.sizes.length, 1);
  assert.equal(m.fw().count('showInactive'), 1);
  assert.equal(m.fw().last('setFocusable').args[0], false);
});

test('a destroyed window is told nothing; close() unwires everything', () => {
  const m = make({ overlay: { input: 'toggle' } });
  m.create();
  m.fw().win.destroy();
  const n = m.fw().calls.length;
  m.ctl.fit();
  m.ctl.raise();
  m.ctl.focus(true);
  m.ctl.setZones({ rects: [{ x: 0, y: 0, width: 1, height: 1 }], dpr: 1 });
  m.fake.emitPointer({ x: 0, y: 0 });
  m.clock.advance(1000);
  assert.equal(m.fw().calls.length, n);
  m.ctl.close();
});

// ---------- the invariant: any caps × any events ----------

// A deterministic PRNG: the same seed replays the same sequence.
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const INPUTS = ['xshape', 'toggle', 'passthrough'];
const SIDES = ['client', 'compositor'];

for (const input of INPUTS) for (const place of SIDES) for (const stacking of SIDES) for (const focus of SIDES) {
  test(`invariant: ${input} / place=${place} stacking=${stacking} focus=${focus}`, () => {
    for (let seed = 1; seed <= 4; seed++) {
      const rand = rng(seed * 7919);
      const m = make({ overlay: { input, place, stacking, focus } });
      m.create({ managed: focus === 'compositor' });
      const fw = m.fw();
      let zones = [];
      let pointer = null;
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];
      const inZone = () => Boolean(pointer) && zones.some((r) => (
        pointer.x >= r.x - PADDING && pointer.x <= r.x + r.width + PADDING
        && pointer.y >= r.y - PADDING && pointer.y <= r.y + r.height + PADDING));

      // Either the window ignores the mouse, or the pointer is inside an interactive zone. The
      // toggle's give-back grace is settled before judging; the shape strategies must always
      // carry exactly the zones (empty: nowhere).
      const check = () => {
        if (input === 'passthrough') {
          const last = fw.last('setIgnoreMouseEvents');
          assert.ok(last && last.args[0] === true, `seed ${seed}: passthrough took the mouse`);
        } else if (input === 'toggle') {
          if (m.ctl.inputState().ignoring === false && !inZone()) {
            m.clock.advance(LEAVE_MS);
            assert.equal(m.ctl.inputState().ignoring, true, `seed ${seed}: the mouse was kept outside every zone`);
          }
        } else {
          const want = zones
            .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }))
            .filter((r) => r.width > 0 && r.height > 0);
          assert.deepEqual(fw.last('setShape').args[0], want.length ? want : OFFSCREEN, `seed ${seed}: the shape is not the zones`);
        }
      };

      check();
      for (let i = 0; i < 30; i++) {
        const ev = pick(['resize', 'show', 'theme', 'pointer', 'zones', 'focus', 'moved', 'maximize']);
        if (ev === 'zones') {
          zones = Array.from({ length: Math.floor(rand() * 4) }, () => ({
            x: Math.floor(rand() * 1800), y: Math.floor(rand() * 900),
            width: Math.floor(rand() * 300), height: Math.floor(rand() * 200),
          }));
          m.ctl.setZones({ rects: zones, dpr: 1 });
        } else if (ev === 'pointer') {
          pointer = { x: Math.floor(rand() * 1920), y: Math.floor(rand() * 1040) };
          m.fake.emitPointer(pointer);
        } else if (ev === 'theme') {
          m.theme.emit('updated');
        } else if (ev === 'focus') {
          m.ctl.focus(rand() < 0.5);
        } else if (ev === 'resize') {
          m.setArea({ x: 0, y: 0, width: 1280 + Math.floor(rand() * 600), height: 800 });
          m.ctl.fit();
          fw.emit('resize');
        } else {
          fw.emit(ev);
        }
        m.clock.advance(0); // the deferred reapplies
        check();
      }
      m.clock.advance(LEAVE_MS);
      check();
      m.ctl.close();
    }
  });
}