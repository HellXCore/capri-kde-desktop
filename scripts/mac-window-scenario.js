'use strict';

// macOS window-watch scenario (CAPRI-08 prototype). Opens its own test windows, moves, minimizes,
// closes and full-screens them, and checks what the Swift helper reports after each step.
// Run on a Mac: node scripts/mac-window-scenario.js   (it builds what is missing with swiftc)
// The test windows show up on screen for a few seconds and full screen opens a new Space.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { parseLine, toUpdate, HELPER } = require('../src/main/mac/window-watch');

if (process.platform !== 'darwin') {
  console.log('macOS only');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(os.tmpdir(), 'capri-mac-window-fixture');

function build(source, out) {
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log(`building ${path.relative(ROOT, source)}`);
  execFileSync('swiftc', ['-O', '-target', 'arm64-apple-macos12.0', '-o', out, source], { stdio: 'inherit' });
}
build(path.join(ROOT, 'src/main/mac/capri-windows.swift'), HELPER);
build(path.join(ROOT, 'tools/mac-window-fixture.swift'), FIXTURE);

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` - ${detail}` : ''}`);
};

// the helper, and its latest snapshot
const helper = spawn(HELPER, ['--parent', String(process.pid), '--watch-stdin', '--interval', '100'], { stdio: ['pipe', 'pipe', 'inherit'] });
let snap = null;
let lines = 0;
readline.createInterface({ input: helper.stdout }).on('line', (line) => {
  const s = parseLine(line);
  if (s) { snap = s; lines++; }
});

// the test windows
const fixture = spawn(FIXTURE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = [];
let waiting = null;
readline.createInterface({ input: fixture.stdout }).on('line', (line) => {
  const r = JSON.parse(line);
  if (waiting) { const w = waiting; waiting = null; w(r); } else replies.push(r);
});
const cmd = (line) => new Promise((resolve) => {
  waiting = resolve;
  fixture.stdin.write(`${line}\n`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = snap && pred(snap);
    if (v) return { value: v, ms: Date.now() - t0 };
    await sleep(25);
  }
  return null;
}
const find = (s, id) => s.wins.find((w) => w.id === id);
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
// Opening and restoring animate the frame (it grows from a few points inside); the helper reports
// those frames too and the final one when it settles. On a locked screen the animation stalls
// part-way, so there only close is expected.
const near = (a, b) => a && b && [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h].every((d) => Math.abs(d) <= (locked ? 16 : 0));
const delta = (w, f) => `CG ${rect(w)} vs NSWindow ${rect(f)}`;
const rect = (r) => `${r.x},${r.y} ${r.w}x${r.h}`;

// a check that macOS cannot carry out on a locked screen (its display asleep) is skipped there
async function check(name, pred, describe, timeout, { lockedSkip = false } = {}) {
  const hit = await until(pred, timeout);
  if (hit) record(name, 'PASS', `${describe ? describe(hit.value) : ''} (${hit.ms} ms)`.trim());
  else if (lockedSkip && locked) record(name, 'SKIP', 'not carried out by macOS while the screen is locked');
  else record(name, 'FAIL', snap ? `last: fg=${snap.fg}, ${snap.wins.length} windows` : 'no snapshot');
  return hit;
}

let locked = false;

async function main() {
  await until((s) => s, 3000);
  if (!snap) throw new Error('the helper printed nothing');
  const helperStart = Date.now();
  const fr = await cmd('front');
  locked = fr.bundle === 'com.apple.loginwindow';
  if (locked) record('session', 'INFO', 'the screen is locked: focus, close animation and full screen are not exercised');

  // displays: the helper's points against the fixture's own NSScreen frames
  const { screens } = await cmd('screens');
  const okScreens = screens.length === snap.displays.length
    && screens.every((s) => snap.displays.some((d) => same(d, s) && d.scale === s.scale));
  record('displays match NSScreen (points, scale)', okScreens ? 'PASS' : 'FAIL',
    screens.map((s) => `${rect(s)} @${s.scale}x`).join('; '));
  const main = snap.displays.find((d) => d.x === 0 && d.y === 0) || snap.displays[0];
  const overlay = { x: main.x, y: main.y, width: main.w, height: main.h };
  const others = snap.wins.length;

  const a = await cmd('open a 200 200 640 420');
  await check('open: window listed with its frame', (s) => near(find(s, a.id), a) && find(s, a.id), (w) => delta(w, a));
  // focus: macOS lets an app take it only when the active one yields, and never on a locked screen
  const focusNow = (await cmd('front')).front === fr.self;
  if (focusNow) await check('open: active window is the new one', (s) => s.fg === a.id, () => `fg=${a.id}`);
  else record('active window', 'SKIP', `the test app did not get focus; front app: ${(await cmd('front')).bundle || 'unknown'}, helper fg=${snap.fg}`);

  const b = await cmd('open b 100 300 700 400');
  // macOS keeps a window being ordered in on screen, so it goes off the left edge afterwards
  const bl = await cmd('move b -250 300');
  await check('negative x: frame reported as is', (s) => near(find(s, b.id), bl) && find(s, b.id).x < 0 && find(s, b.id), (w) => delta(w, bl));
  await check('negative x: kept in the overlay update', (s) => toUpdate(s, overlay).wins.find((w) => w.id === b.id), (w) => `overlay-relative ${rect(w)}`);
  if (focusNow) await check('active window follows focus', (s) => s.fg === b.id, () => `fg=${b.id}`);
  await check('z-order: front first', (s) => s.wins.findIndex((w) => w.id === b.id) >= 0 && s.wins.findIndex((w) => w.id === b.id) < s.wins.findIndex((w) => w.id === a.id));

  const moved = await cmd('move a 520 260');
  await check('move: new frame', (s) => near(find(s, a.id), moved) && find(s, a.id), (w) => delta(w, moved));

  await cmd('min a');
  await check('minimize: window gone', (s) => !find(s, a.id) && find(s, b.id));
  await cmd('restore a');
  await check('restore: window back', (s) => near(find(s, a.id), moved) && find(s, a.id), (w) => rect(w));

  await cmd('apphide');
  await check('app hidden (Cmd-H): its windows gone', (s) => !find(s, a.id) && !find(s, b.id));
  await cmd('appunhide');
  await check('app shown again: windows back', (s) => find(s, a.id) && find(s, b.id));

  await cmd('hide b');
  await check('hide (orderOut): window gone', (s) => !find(s, b.id));
  const c = await cmd('open c 300 400 500 300');
  await until((s) => find(s, c.id));
  await cmd('close c');
  await check('close: window gone', (s) => !find(s, c.id), null, 4000, { lockedSkip: true });

  await cmd('full a');
  const full = await check('full screen: own Space, frame = display', (s) => {
    const w = find(s, a.id);
    return w && w.full && w.max && s.displays.some((d) => same(d, w)) && w;
  }, (w) => rect(w), 6000, { lockedSkip: true });
  if (full) {
    await sleep(500);
    const rest = snap.wins.filter((w) => w.id !== a.id).length;
    record('full screen: other Spaces\' windows hidden', rest < others ? 'PASS' : 'INFO', `${others} windows before, ${rest} besides it now`);
    await sleep(1000);
    const st = await cmd('state a');
    record('full screen: AppKit agrees', st.full ? 'PASS' : 'FAIL', `styleMask.fullScreen=${st.full}`);
    await cmd('unfull a');
    await check('leave full screen: frame back', (s) => near(find(s, a.id), moved) && !find(s, a.id).full && find(s, a.id), (w) => rect(w), 6000);
    await check('leave full screen: other windows back', (s) => s.wins.length > 1 && s, (s) => `${s.wins.length} windows`);
  }

  if (snap.displays.length > 1) {
    const second = snap.displays.find((d) => d !== main);
    const there = await cmd(`move a ${second.x + 100} ${second.y + 100}`);
    await check('second display: frame in global points', (s) => near(find(s, a.id), there) && find(s, a.id), (w) => rect(w));
  } else {
    record('second display', 'SKIP', 'one display connected');
  }

  // the test app quits: all its windows go
  fixture.stdin.end();
  await check('app quits: its windows gone', (s) => !find(s, a.id) && !find(s, c.id));

  // CPU used by the helper during the run
  const cpu = execFileSync('ps', ['-o', 'time=', '-p', String(helper.pid)]).toString().trim();
  record('helper CPU time', 'INFO', `${cpu} over ${((Date.now() - helperStart) / 1000).toFixed(1)} s at 100 ms polling, ${lines} snapshots`);

  // it goes when its stdin closes (what happens if Capri dies)
  const gone = new Promise((r) => helper.once('exit', () => r(true)));
  helper.stdin.end();
  record('helper exits when the pipe closes', (await Promise.race([gone, sleep(1500).then(() => false)])) ? 'PASS' : 'FAIL');
}

main()
  .catch((err) => record('scenario', 'FAIL', err.message))
  .finally(() => {
    helper.kill();
    fixture.kill();
    const failed = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${results.length - failed}/${results.length} without failure`);
    process.exit(failed ? 1 : 0);
  });
