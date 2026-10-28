'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { watchPower, RECHECK_MS } = require('../src/main/power');

// Her pause while your screen is locked or the computer asleep (CAPRI-07): main's power.js, the
// renderer's pause.js and what stops and starts with it. These tests only feed stand-in
// powerMonitor events and stand-in timers. They are not a check that a real lock or a real sleep
// sends those events on macOS, Windows or Linux (docs/POWER_EVENTS.md says what's known of that).

const url = (file) => pathToFileURL(path.resolve(__dirname, '../src/renderer/js', file)).href;
const load = async (file) => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} }); // util.js reads it on import
  return import(url(file));
};

// timers on a clock moved by hand
function fakeTimers(start = 0) {
  let now = start;
  let id = 0;
  const intervals = new Map();
  const timeouts = new Map();
  const t = {
    now: () => now,
    setInterval: (fn, ms) => {
      intervals.set(++id, { fn, ms, at: now + ms });
      return id;
    },
    clearInterval: (key) => intervals.delete(key),
    setTimeout: (fn, ms = 0) => {
      timeouts.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (key) => timeouts.delete(key),
    get intervals() {
      return intervals.size;
    },
    get timeouts() {
      return timeouts.size;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...intervals.entries(), ...timeouts.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [key, x] = due;
        now = x.at;
        if (intervals.has(key)) x.at += x.ms;
        else timeouts.delete(key);
        x.fn();
      }
      now = end;
    },
  };
  return t;
}

// Electron's powerMonitor, stood in for: events, and what getSystemIdleState says
function fakePower(idle = 'active') {
  const power = new EventEmitter();
  power.idle = idle;
  power.getSystemIdleState = () => power.idle;
  return power;
}

const EVENTS = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'user-did-resign-active', 'user-did-become-active'];

// ---------- main: power.js ----------

test('power: several lock/unlock and sleep/wake cycles, one change each way, listeners never pile up', () => {
  const power = fakePower();
  const timers = fakeTimers();
  const changes = [];
  const watch = watchPower({ power, platform: 'darwin', onChange: (s) => changes.push(s.away), later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  for (const e of EVENTS) assert.equal(power.listenerCount(e), 1, e);
  for (let i = 0; i < 5; i++) {
    power.emit('lock-screen');
    power.idle = 'locked';
    power.emit('lock-screen'); // said twice: nothing more
    assert.equal(watch.away, true);
    power.idle = 'active';
    power.emit('unlock-screen');
    assert.equal(watch.away, false);
    power.emit('suspend');
    power.emit('resume');
  }
  assert.deepEqual(changes, Array.from({ length: 20 }, (_, i) => i % 2 === 0));
  for (const e of EVENTS) assert.equal(power.listenerCount(e), 1, e);
  assert.equal(timers.intervals, 0, 'no recheck left once unlocked');
  watch.stop();
  for (const e of EVENTS) assert.equal(power.listenerCount(e), 0, e);
});

test('power: woken with the screen still locked, she stays paused until it is unlocked', () => {
  const power = fakePower('locked');
  const changes = [];
  const timers = fakeTimers();
  power.idle = 'active';
  const watch = watchPower({ power, platform: 'win32', onChange: (s) => changes.push(s), later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  power.emit('lock-screen');
  power.idle = 'locked';
  power.emit('suspend');
  power.emit('resume'); // the lock screen is up after the wake
  assert.equal(watch.away, true);
  assert.deepEqual(watch.state().why, ['locked']);
  power.idle = 'active';
  power.emit('unlock-screen');
  assert.equal(watch.away, false);
  assert.deepEqual(changes.map((s) => s.away), [true, false]);
  watch.stop();
});

test('power: an unlock event that never comes is caught by the recheck (macOS, Windows), one timer only while locked', () => {
  const power = fakePower();
  const timers = fakeTimers();
  const changes = [];
  const watch = watchPower({ power, platform: 'darwin', onChange: (s) => changes.push(s.away), later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  power.emit('lock-screen');
  power.idle = 'locked';
  assert.equal(timers.intervals, 1);
  power.emit('lock-screen');
  power.emit('user-did-resign-active');
  assert.equal(timers.intervals, 1, 'never two rechecks');
  timers.advance(RECHECK_MS * 3);
  assert.equal(watch.away, true, 'still locked: still paused');
  power.emit('user-did-become-active');
  power.idle = 'active'; // unlocked, but Electron never said so
  timers.advance(RECHECK_MS);
  assert.equal(watch.away, false);
  assert.equal(timers.intervals, 0);
  assert.deepEqual(changes, [true, false]);
  // and at a wake: locked before the sleep, not locked any more after it
  power.emit('lock-screen');
  power.emit('suspend');
  power.emit('resume');
  assert.equal(watch.away, false);
  watch.stop();
});

test('power: Linux has no lock events in Electron and nothing is polled; sleep still pauses her', () => {
  const power = fakePower('locked'); // whatever it says, it isn't asked
  let asked = 0;
  power.getSystemIdleState = () => {
    asked++;
    return 'locked';
  };
  const timers = fakeTimers();
  const changes = [];
  const watch = watchPower({ power, platform: 'linux', onChange: (s) => changes.push(s.away), later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  assert.equal(watch.away, false, 'not paused at start on the idle state alone');
  power.emit('suspend');
  power.emit('resume');
  power.emit('lock-screen'); // should a future Electron send it: it pauses her, without a recheck
  assert.equal(timers.intervals, 0);
  power.emit('unlock-screen');
  assert.equal(asked, 0);
  assert.deepEqual(changes, [true, false, true, false]);
  watch.stop();
});

test('power: started behind the lock screen, paused from the start; --dev test pause holds until lifted', () => {
  const power = fakePower('locked');
  const timers = fakeTimers();
  const watch = watchPower({ power, platform: 'darwin', later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  assert.equal(watch.away, true);
  power.idle = 'active';
  power.emit('unlock-screen');
  assert.equal(watch.away, false);
  watch.test(true);
  timers.advance(RECHECK_MS * 4);
  assert.equal(watch.away, true, 'the recheck leaves a test pause alone');
  watch.emit('suspend');
  watch.emit('resume');
  assert.equal(watch.away, true);
  watch.test(false);
  assert.equal(watch.away, false);
  watch.stop();
});

// ---------- renderer: pause.js ----------

test('pause: every() keeps one timer, cleared while paused and set again once back, over many cycles', async () => {
  const { Pause } = await load('pause.js');
  const timers = fakeTimers();
  const pause = new Pause({ now: timers.now, timers });
  let ticks = 0;
  const a = pause.every(() => ticks++, 1000);
  pause.every(() => {}, 3000);
  assert.equal(timers.intervals, 2);
  timers.advance(5000);
  assert.equal(ticks, 5);
  for (let i = 0; i < 6; i++) {
    assert.equal(pause.set(true), true);
    assert.equal(pause.set(true), false, 'paused twice: nothing more');
    assert.equal(timers.intervals, 0);
    timers.advance(60 * 60 * 1000); // an hour away
    assert.equal(pause.set(false), true);
    assert.equal(pause.set(false), false);
    assert.equal(timers.intervals, 2, `cycle ${i}: one timer each, never two`);
  }
  assert.equal(ticks, 5, 'nothing ran while paused, nothing caught up after');
  timers.advance(1000);
  assert.equal(ticks, 6);
  a.stop();
  assert.equal(timers.intervals, 1);
  pause.set(true);
  pause.set(false);
  assert.equal(timers.intervals, 1, 'a stopped one stays stopped');
});

test('pause: each part hears of it once per change, with the time paused', async () => {
  const { Pause } = await load('pause.js');
  const timers = fakeTimers(1000);
  const pause = new Pause({ now: timers.now, timers });
  const heard = [];
  const off = pause.on({ pause: () => heard.push('pause'), resume: (gap) => heard.push(gap) });
  pause.set(true);
  pause.set(true);
  timers.advance(42000);
  pause.set(false);
  pause.set(false);
  off();
  pause.set(true);
  pause.set(false);
  assert.deepEqual(heard, ['pause', 42000]);
});

test('pause: what is kept for later goes by Panel priorities, the newer one on a tie (a prompt put out by a prompt only)', async () => {
  const { keepFor } = await load('pause.js');
  const P = { info: 1, idle: 1, work: 2, done: 3, error: 3, report: 3, chat: 3, alert: 4, remind: 4 };
  const done1 = { kind: 'done', line: 'one' };
  const done2 = { kind: 'done', line: 'two' };
  const alert = { kind: 'alert' };
  let kept = null;
  for (const msg of [{ kind: 'info' }, { kind: 'work' }, { kind: 'idle' }]) kept = keepFor(kept, msg, P);
  assert.equal(kept, null, 'optional and progress lines are not kept');
  kept = keepFor(kept, done1, P);
  kept = keepFor(kept, done2, P);
  assert.equal(kept, done2);
  kept = keepFor(kept, alert, P);
  kept = keepFor(kept, { kind: 'error' }, P);
  assert.equal(kept, alert);
  // a reminder, as high, doesn't put a permission prompt out (Claude waits on it); a newer prompt does
  kept = keepFor(kept, { kind: 'remind' }, P);
  assert.equal(kept, alert);
  const alert2 = { kind: 'alert' };
  assert.equal(keepFor(kept, alert2, P), alert2);
});

test('panel: a reminder kept while paused and put out by a prompt is told it was never seen', async (t) => {
  const { panel } = await makePanel(t);
  const left = [];
  panel.pause();
  panel.say({ kind: 'remind', line: 'tea', hold: null, onLeave: (how) => left.push(how) });
  assert.equal(panel.say({ kind: 'alert', line: 'may I?', hold: null }), true);
  assert.deepEqual(left, [{ unseen: true }]);
  assert.equal(panel.say({ kind: 'remind', line: 'call', hold: null }), false, 'the prompt stays kept');
  panel.unpause(1000);
  assert.equal(panel.current.kind, 'alert');
});

test('power: a resume that never comes is made up for by the unlock (you are at it: it is awake)', () => {
  const power = fakePower();
  const timers = fakeTimers();
  const watch = watchPower({ power, platform: 'win32', later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  power.emit('lock-screen');
  power.idle = 'locked';
  power.emit('suspend'); // Modern Standby: no resume after it
  power.idle = 'active';
  power.emit('unlock-screen');
  assert.equal(watch.away, false);
  assert.deepEqual(watch.state().why, []);
  assert.equal(timers.intervals, 0);
  // and back from another user (macOS)
  const mac = watchPower({ power: fakePower(), platform: 'darwin', later: { every: timers.setInterval, stop: timers.clearInterval }, log() {} });
  mac.emit('user-did-resign-active');
  mac.emit('suspend');
  mac.emit('user-did-become-active');
  assert.equal(mac.away, false);
  watch.stop();
  mac.stop();
});

// ---------- renderer: her panel ----------

// just enough of a DOM for panel.js
function fakeElement() {
  const classes = new Set();
  const el = {
    hidden: true, textContent: '', value: '', disabled: false, offsetWidth: 200, offsetHeight: 80, scrollTop: 0, scrollHeight: 0,
    dataset: {}, style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener() {}, focus() {}, append() {}, replaceChildren() {},
    querySelector: () => fakeElement(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 80, width: 200, height: 80 }),
  };
  return el;
}

async function makePanel(t) {
  const timers = fakeTimers();
  t.mock.method(globalThis, 'setTimeout', timers.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', timers.clearTimeout);
  t.mock.method(globalThis, 'setInterval', timers.setInterval);
  t.mock.method(globalThis, 'clearInterval', timers.clearInterval);
  t.mock.method(performance, 'now', timers.now);
  globalThis.innerWidth = 1600;
  globalThis.innerHeight = 900;
  globalThis.document ??= { createElement: () => fakeElement(), documentElement: { lang: 'en', dataset: {} } };
  const { Panel } = await load('panel.js');
  const panel = new Panel({ panel: fakeElement(), ticker: fakeElement(), labels: { state: {}, report: { title: '' } } });
  return { panel, timers };
}

test('panel: what came while paused goes up once you are back: the permission prompt, which outranks the done (as on screen)', async (t) => {
  const { panel, timers } = await makePanel(t);
  panel.pause();
  assert.equal(panel.say({ kind: 'info', line: 'optional', hold: 3000 }), false, 'an optional line is dropped');
  assert.equal(panel.say({ kind: 'done', line: 'finished' }), true);
  assert.equal(panel.say({ kind: 'alert', line: 'may I?', hold: null }), true);
  assert.equal(panel.say({ kind: 'work', line: 'progress', hold: 4000 }), false);
  assert.equal(panel.el.hidden, true, 'nothing goes up while paused');
  assert.equal(timers.intervals + timers.timeouts, 0, 'no timer left running while paused');
  timers.advance(30 * 60 * 1000);
  panel.unpause(30 * 60 * 1000);
  assert.equal(panel.el.hidden, false);
  assert.equal(panel.current.kind, 'alert');
  assert.equal(panel.current.line, 'may I?');
  assert.equal(panel.kept, null);
});

test('panel: a prompt dealt with while paused is not shown after; the message on screen keeps its time left', async (t) => {
  const { panel, timers } = await makePanel(t);
  panel.say({ kind: 'done', line: 'finished', hold: 6000 });
  timers.advance(1000);
  panel.pause();
  panel.say({ kind: 'alert', line: 'may I?', hold: null });
  panel.clearKind('alert'); // answered in the terminal meanwhile
  timers.advance(10 * 60 * 1000);
  assert.equal(panel.el.hidden, false, 'not timed out while you were away');
  panel.unpause(10 * 60 * 1000);
  assert.equal(panel.current.line, 'finished');
  timers.advance(4900);
  assert.equal(panel.current?.line, 'finished');
  timers.advance(200);
  assert.equal(panel.current, null, 'then it goes, its 5 s left used up');
});

test('panel: the line decoding in when she pauses is finished at once, no decode timer left', async (t) => {
  const { panel, timers } = await makePanel(t);
  panel.say({ kind: 'done', line: 'a fairly long line that decodes in over many steps', hold: null });
  assert.equal(timers.intervals, 1);
  panel.pause();
  assert.equal(timers.intervals, 0);
  assert.equal(panel.line.textContent, 'a fairly long line that decodes in over many steps');
  panel.unpause(1000);
  assert.equal(timers.intervals, 0);
});

// ---------- renderer: her optional lines ----------

test('initiative: nothing optional while paused, and no burst of them after; an idle line waits its turn', async () => {
  const { Initiative, occupied } = await load('initiative.js');
  const { Pause } = await load('pause.js');
  const timers = fakeTimers(10 * 60 * 1000);
  const pause = new Pause({ now: timers.now, timers });
  const panel = { visible: false, current: null, paused: false };
  const initiative = new Initiative({ level: 'active', now: timers.now, rng: () => 0, busy: () => occupied({ panel }) });
  const said = [];
  pause.on({ pause: () => { panel.paused = true; }, resume: () => { panel.paused = false; initiative.delay('idle'); } }); // as app.js does
  // app.js's 20 s idle timer, and lines that come by chance (a gaze, a hello from another screen)
  pause.every(() => initiative.offer('idle', () => said.push(['idle', timers.now()])), 20000);
  pause.every(() => {
    if (initiative.chance(0.4)) initiative.offer('ambient', () => said.push(['ambient', timers.now()]));
  }, 7000);
  timers.advance(60000);
  const before = said.length;
  assert.ok(before >= 1);
  pause.set(true);
  for (const kind of ['idle', 'ambient', 'progress', 'pc', 'session']) {
    assert.equal(initiative.offer(kind, () => said.push([kind, timers.now()])), false, kind);
  }
  timers.advance(2 * 60 * 60 * 1000);
  assert.equal(said.length, before, 'nothing said, nothing queued');
  pause.set(false);
  const back = timers.now();
  timers.advance(60000);
  const after = said.slice(before);
  assert.ok(after.length <= 2, `${after.length} lines in the first minute back`);
  assert.ok(after.every(([kind]) => kind !== 'idle'), 'no idle line right away');
  for (let i = 1; i < after.length; i++) assert.ok(after[i][1] - after[i - 1][1] >= 6000, 'her gap between optional lines holds');
  assert.ok(!after.length || after[0][1] > back, 'nothing at the very moment she is back');
});

// ---------- renderer: her loops ----------

// a 60 Hz screen: requestAnimationFrame on fake timers
function fakeScreen(t, timers) {
  let id = 0;
  const frames = new Map();
  t.mock.method(globalThis, 'setTimeout', timers.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', timers.clearTimeout);
  t.mock.method(performance, 'now', timers.now);
  globalThis.requestAnimationFrame = (fn) => {
    frames.set(++id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (key) => frames.delete(key);
  return {
    get pending() {
      return frames.size + timers.timeouts;
    },
    refresh() {
      const due = [...frames.values()];
      frames.clear();
      for (const fn of due) fn(timers.now());
    },
  };
}

test('capri: the loop stops while paused and comes back as one loop, over many cycles', async (t) => {
  const { Capri } = await load('capri.js');
  const timers = fakeTimers(1000);
  const screen = fakeScreen(t, timers);
  const capri = Object.create(Capri.prototype);
  let drawn = 0;
  Object.assign(capri, {
    looping: true, nextFrame: null, lastDraw: 0, stance: 'stand', mode: 'idle', act: null, skid: null, _busy: false, _hidden: false,
    drawFrame(now) { this.lastDraw = now; drawn++; },
    behave() {},
  });
  capri.loop = Capri.prototype.loop.bind(capri);
  capri.schedule();
  for (let i = 0; i < 4; i++) {
    timers.advance(1000 / 60);
    screen.refresh();
  }
  assert.ok(drawn >= 1);
  for (let cycle = 0; cycle < 5; cycle++) {
    capri.paused = true;
    assert.equal(screen.pending, 0, 'nothing waiting while paused');
    const n = drawn;
    timers.advance(10 * 60 * 1000);
    screen.refresh();
    assert.equal(drawn, n, 'nothing drawn while paused');
    capri.shiftClock(10 * 60 * 1000);
    capri.paused = false;
    assert.equal(screen.pending, 1, `cycle ${cycle}: one frame waited for`);
    capri.paused = false;
    assert.equal(screen.pending, 1, 'back twice: still one');
  }
});

test('capri: back after a long pause, her clocks go on from where they were; one set meanwhile stays', async () => {
  const { Capri } = await load('capri.js');
  const capri = Object.create(Capri.prototype);
  const flight = { last: 5000, freezeUntil: 0, v: { x: 300, y: 0 } };
  Object.assign(capri, {
    looping: false, lastDraw: 5000, lastActivity: 4000, nextTwitch: 9000, nextMove: 60000, nextGaze: 70000, nextShed: 6000,
    nextNotice: 0, peekUntil: 0, lastGlyph: 0, sleptAt: 0, nextHome: 0, lastFall: 0, refuseUntil: 0,
    base: { start: 3000 }, act: { player: { start: 4500 } }, held: null, flight, skid: null,
  });
  capri.paused = true;
  const gap = 3 * 60 * 60 * 1000;
  capri.lastActivity = 5000 + gap / 2; // Claude's prompt came in while you were away (setMode)
  capri.shiftClock(gap);
  capri.paused = false;
  assert.equal(capri.nextTwitch, 9000 + gap, 'a twitch 4 s after the pause, 4 s after you are back');
  assert.equal(capri.nextMove, 60000 + gap);
  assert.equal(capri.lastDraw, 5000 + gap);
  assert.equal(capri.base.start, 3000 + gap);
  assert.equal(capri.act.player.start, 4500 + gap, 'an act goes on where it stopped instead of ending');
  assert.equal(flight.last, 5000 + gap, 'a throw steps from where it was, not by three hours');
  assert.equal(capri.lastActivity, 5000 + gap / 2, 'set during the pause: left as it is');
  assert.equal(capri.nextNotice, 0, 'never set: left as it is');
});

test('fx: paused effects wait, then go on as one loop; one added meanwhile is not pushed on', async (t) => {
  const { FxLayer } = await load('fx.js');
  const timers = fakeTimers(1000);
  const screen = fakeScreen(t, timers);
  const fx = Object.create(FxLayer.prototype);
  Object.assign(fx, { items: [], running: false, last: 0, nextFrame: null, paused: false });
  fx.frame = () => {};
  const shard = fx.add({ type: 'shard', life: 900 });
  assert.equal(screen.pending, 1);
  fx.pause();
  assert.equal(screen.pending, 0);
  timers.advance(20000);
  const glyph = fx.add({ type: 'glyph', life: 600 });
  assert.equal(screen.pending, 0, 'added while paused: no frame yet');
  timers.advance(20000);
  fx.unpause(40000);
  fx.unpause(40000);
  assert.equal(screen.pending, 1, 'one loop again');
  assert.equal(shard.born, 1000 + 40000);
  assert.equal(glyph.born, 21000);
});

// ---------- renderer: her reminders ----------

test('reminders: due while paused, brought up once you are back (the earliest first, one at a time)', async (t) => {
  const timers = fakeTimers();
  t.mock.method(globalThis, 'setInterval', timers.setInterval);
  t.mock.method(Date, 'now', () => 1_000_000 + timers.now());
  const { Reminders } = await load('reminders.js');
  const { pause } = await load('pause.js');
  const saved = [];
  const reminders = new Reminders({ host: { setConfig: (p) => saved.push(p) }, list: [] });
  const due = [];
  reminders.onDue = (r) => due.push(r.text);
  reminders.add(Date.now() + 60000, 'tea');
  reminders.add(Date.now() + 120000, 'call');
  pause.set(true);
  try {
    timers.advance(10 * 60 * 1000);
    assert.deepEqual(due, [], 'kept, not shown while paused');
    assert.equal(reminders.list.length, 2);
  } finally {
    pause.set(false);
  }
  timers.advance(5000);
  assert.deepEqual(due, ['tea']);
  reminders.remove(reminders.list.find((r) => r.text === 'tea').id);
  timers.advance(5000);
  assert.deepEqual(due, ['tea', 'call']);
});

test('panel: Claude\'s tools are not flashed on the ticker while paused; the last one is shown once back', async (t) => {
  const { panel, timers } = await makePanel(t);
  panel.pause();
  for (const verb of ['Read', 'Edit', 'Bash']) panel.setTicker({ verb, target: 'a.js' });
  timers.advance(5000);
  assert.equal(panel.tickerEl.hidden, true);
  assert.equal(timers.timeouts, 0);
  panel.unpause(5000);
  timers.advance(500);
  assert.equal(panel.tickerEl.hidden, false);
  assert.equal(panel.tickerVerb.textContent, 'Bash');
});
