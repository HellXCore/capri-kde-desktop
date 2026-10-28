'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// frameIn (util.js): the loops drawn on twos wait with a timer until just before their next drawing
// is due, then take the next screen refresh, instead of asking for every refresh (CAPRI-06).
const url = pathToFileURL(path.resolve(__dirname, '../src/renderer/js/util.js')).href;

// a 60 Hz screen and timers on a clock moved by hand
function fakeScreen(t) {
  const REFRESH = 1000 / 60;
  let now = 0;
  let id = 0;
  const timers = new Map();
  const frames = new Map();
  const stats = { rafs: 0, timers: 0 };
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    stats.timers++;
    timers.set(++id, { fn, at: now + ms });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (key) => timers.delete(key));
  globalThis.requestAnimationFrame = (fn) => {
    stats.rafs++;
    frames.set(++id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (key) => frames.delete(key);
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  // runs everything due up to `until`: timers when they're due, frames on each refresh
  let refreshes = 0; // counted, so the refresh times never get stuck on a rounding error
  const run = (until) => {
    while (now < until) {
      const nextRefresh = (refreshes + 1) * REFRESH;
      const timer = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (timer && timer[1].at <= nextRefresh) {
        now = Math.max(now, timer[1].at);
        timers.delete(timer[0]);
        timer[1].fn();
        continue;
      }
      now = nextRefresh;
      refreshes++;
      const due = [...frames.entries()];
      frames.clear();
      for (const [, fn] of due) fn(now);
    }
  };
  return { run, stats, now: () => now, REFRESH };
}

test('frameIn lands on a refresh within one refresh of the delay, with one frame request', async (t) => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const { frameIn } = await import(url);
  const screen = fakeScreen(t);
  let at = null;
  frameIn(1000 / 12, (time) => { at = time; });
  screen.run(200);
  assert.ok(at >= 1000 / 12 - screen.REFRESH, `drawn too early: ${at}`); // the loops check the time themselves
  assert.ok(at < 1000 / 12 + screen.REFRESH, `drawn a refresh late: ${at}`);
  assert.equal(screen.stats.rafs, 1); // not one per refresh while waiting
});

test('frameIn with no delay takes the next refresh, and cancels', async (t) => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const { frameIn } = await import(url);
  const screen = fakeScreen(t);
  let calls = 0;
  frameIn(0, () => calls++);
  screen.run(20);
  assert.equal(calls, 1);
  assert.equal(screen.stats.timers, 0);
  const cancel = frameIn(100, () => calls++);
  cancel();
  const cancelSoon = frameIn(5, () => calls++); // already a frame request: cancelled too
  cancelSoon();
  screen.run(300);
  assert.equal(calls, 1);
});

test('a loop on twos through frameIn draws at 12 fps with about two frame requests a drawing', async (t) => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const { frameIn } = await import(url);
  const screen = fakeScreen(t);
  const STEP = 1000 / 12;
  let last = 0;
  let draws = 0;
  const loop = (now) => {
    if (now - last >= STEP - 1) {
      last = now;
      draws++;
    }
    frameIn(last + STEP - now, loop); // the clock is the refresh time here
  };
  frameIn(0, loop);
  screen.run(10000);
  assert.ok(draws >= 118 && draws <= 121, `draws: ${draws}`); // 12 a second, as with a request every refresh
  assert.ok(screen.stats.rafs <= draws * 2 + 2, `frame requests: ${screen.stats.rafs}`); // was 600 (one per refresh)
});
