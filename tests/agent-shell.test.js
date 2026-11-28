'use strict';

// What the shell adds on top of the contract: the wishes replayed after a restart, the requests in
// flight refused with a code that says what happened, the beat watchdog, and the two refusals that
// retrying cannot fix. Everything on a clock moved by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentShell } = require('../src/main/platform/shell/agent-shell');
const { createFakeClock } = require('./fakes/fake-clock');
const { memoryLauncher } = require('./fakes/agent-launcher');
const { CAPS } = require('./fakes/agent-fake');
const { ENV, DISPLAY } = require('./fakes/agent-messages');

const flush = () => new Promise((r) => setImmediate(r));
const back = async (clock, ms = 250) => { clock.advance(ms); await flush(); await flush(); };

function make({ caps = CAPS, ...opts } = {}) {
  const clock = createFakeClock();
  const launcher = memoryLauncher({ caps, beatMs: 0 });
  const lines = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (m) => lines.push([level, m]);
  const shell = createAgentShell({ launcher, entry: 'memory', env: ENV, expected: CAPS, clock, log, ...opts });
  return { shell, clock, launcher, lines, control: (t, p) => launcher.made.at(-1).control(t, p) };
}

test('the wishes are replayed on every ready, in the order the agent needs them', async () => {
  const m = make();
  m.shell.setDisplays([DISPLAY]);
  m.shell.overlay.identity({ pid: 4242, title: 'capri-overlay', xid: null });
  m.shell.overlay.zones({ rects: [{ x: 1, y: 2, w: 3, h: 4 }], dpr: 2 });
  m.shell.overlay.focus(true);
  assert.equal(await m.shell.control.hotkey('stow', 'Ctrl+Alt+C'), true);
  await m.shell.start();
  const order = ['hello', 'displays', 'overlay.zones', 'overlay.focus', 'hotkey.set'];
  assert.deepEqual(m.launcher.made[0].received.map((x) => x.type), order);
  assert.deepEqual(m.launcher.made[0].received[0].payload.overlay, { pid: 4242, title: 'capri-overlay', xid: null });
  m.control('fake.exit');
  await back(m.clock);
  assert.equal(m.launcher.made.length, 2);
  assert.deepEqual(m.launcher.made[1].received.map((x) => x.type), order);
  assert.equal(m.shell.health.last().state, 'ready');
  await m.shell.stop();
});

test('a request in flight when the agent dies is refused, and the next one is answered', async () => {
  const m = make();
  await m.shell.start();
  m.control('fake.stall');
  const shot = m.shell.os.screenshot({ display: DISPLAY, multi: false });
  const refused = assert.rejects(shot, (err) => err instanceof Error && err.code === 'agent-restarted');
  m.control('fake.exit');
  await refused;
  assert.equal(m.shell.health.last().state, 'degraded');
  await back(m.clock);
  assert.equal(m.shell.health.last().state, 'ready');
  assert.ok(Buffer.isBuffer(await m.shell.os.screenshot({ display: DISPLAY, multi: false })));
  await m.shell.stop();
});

test('the beat watchdog: an agent that goes silent is replaced', async () => {
  const m = make();
  await m.shell.start();
  m.control('fake.mute');
  m.clock.advance(5999);
  assert.equal(m.launcher.made.length, 1);
  m.clock.advance(1);
  assert.equal(m.shell.health.last().state, 'degraded');
  await back(m.clock);
  assert.equal(m.launcher.made.length, 2);
  assert.equal(m.shell.health.last().state, 'ready');
  await m.shell.stop();
});

test('a protocol version this build does not speak is fatal, not a retry loop', async () => {
  const m = make();
  await m.shell.start();
  m.control('fake.raw', { v: 2, kind: 'evt', type: 'beat', payload: { t: 1 } });
  await flush(); // the wire delivers on a microtask: nothing is refused synchronously
  assert.equal(m.shell.health.last().state, 'failed');
  await assert.rejects(m.shell.os.windows(), { code: 'protocol-version' });
  m.clock.advance(600000);
  await flush();
  assert.equal(m.launcher.made.length, 1);
  await m.shell.stop();
});

test('a backend that is not the one this build expects is fatal at the handshake', async () => {
  const m = make({ caps: { ...CAPS, backend: 'x11' } });
  await assert.rejects(m.shell.start(), { code: 'backend-mismatch' });
  assert.equal(m.shell.health.last().state, 'failed');
  m.clock.advance(600000);
  await flush();
  assert.equal(m.launcher.made.length, 1);
});

test('junk from the agent is dropped and counted; the next message still arrives', async () => {
  const m = make();
  await m.shell.start();
  const seen = [];
  m.shell.observe.frames.subscribe((f) => seen.push(f));
  m.control('fake.raw', { v: 1, kind: 'evt', type: 'nope', payload: {} });
  m.control('fake.raw', { v: 1, kind: 'evt', type: 'beat', payload: { t: 'now' } });
  m.control('fake.frame', { rev: 1, fg: 0, dock: false, front: { ai: [], game: null }, wins: [], self: null });
  await flush();
  assert.equal(seen.length, 1);
  // the refusals belong to the shell's own reader, which counts and logs them; the fake's
  // codec counts what arrives on the agent's side, and nothing invalid does
  const refused = m.lines.filter(([level, msg]) => level === 'warn' && /protocol\.invalid/.test(msg));
  assert.equal(refused.length, 2);
  assert.match(refused[0][1], /protocol\.invalid #1 \(unknown\)/);
  assert.match(refused[1][1], /protocol\.invalid #2 \(invalid\)/);
  assert.equal(m.shell.health.last().state, 'ready');
  await m.shell.stop();
});

test('a request that is never answered times out, and the next one is answered', async () => {
  const m = make();
  await m.shell.start();
  m.control('fake.stall');
  const slow = m.shell.os.media('pause');
  m.clock.advance(5000);
  await assert.rejects(slow, { code: 'timeout' });
  m.control('fake.release');
  assert.equal(await m.shell.os.media('pause'), true);
  await m.shell.stop();
});

test("the agent's error is the caller's code; a wrong result shape is refused", async () => {
  const m = make();
  await m.shell.start();
  m.control('fake.override', { type: 'os.launch', err: { code: 'not-found', msg: 'no such app' } });
  await assert.rejects(m.shell.os.launch('x'), { code: 'not-found' });
  m.control('fake.override', { type: 'os.media', payload: 'yes' });
  await assert.rejects(m.shell.os.media('pause'), { code: 'invalid-result' });
  assert.equal(await m.shell.os.terminal(['true']), true);
  await m.shell.stop();
});

test('a picture crosses as base64 and reaches the caller as a Buffer', async () => {
  const m = make();
  await m.shell.start();
  const png = await m.shell.os.screenshot({ display: DISPLAY, multi: false });
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await m.shell.stop();
});

test("caps: the host's expectation before ready, the agent's report after", async () => {
  const m = make();
  assert.deepEqual(m.shell.caps(), CAPS);
  const taken = m.shell.caps();
  taken.apps.list = false;
  assert.equal(m.shell.caps().apps.list, true); // a copy, not the shell's state
  await m.shell.start();
  assert.deepEqual(m.shell.caps(), CAPS);
  await m.shell.stop();
  assert.equal(m.shell.caps().backend, 'kwin');
});

test('requests never throw synchronously; before the agent they are refused', async () => {
  const m = make();
  let p;
  assert.doesNotThrow(() => { p = m.shell.os.windows(); });
  await assert.rejects(p, { code: 'agent-unavailable' });
  await assert.rejects(m.shell.overlay.request({ x: 0, y: 0, w: 10, h: 10 }), { code: 'agent-unavailable' });
  await m.shell.stop();
});

test("the agent's own degraded health is surfaced, and its recovery", async () => {
  const m = make();
  await m.shell.start();
  const seen = [];
  m.shell.health.subscribe((h) => seen.push(h.state));
  m.control('fake.health', { state: 'degraded', reason: 'the session bus is gone' });
  await flush();
  assert.deepEqual(m.shell.health.last(), { state: 'degraded', reason: 'the session bus is gone' });
  assert.equal(await m.shell.os.media('pause'), true); // services still answer
  m.control('fake.health', { state: 'ready' });
  await flush();
  assert.deepEqual(seen, ['degraded', 'ready']);
  await m.shell.stop();
});

test('placement resolves when the compositor confirms it, and is replayed after a restart', async () => {
  const m = make();
  await m.shell.start();
  const rect = { x: 10, y: 20, w: 300, h: 200 };
  const asked = m.shell.overlay.request(rect);
  m.control('fake.actual', { rect: { x: 0, y: 0, w: 1, h: 1 } }); // somewhere else: still waiting
  m.control('fake.actual', { rect });
  assert.deepEqual(await asked, rect);
  m.control('fake.exit');
  await back(m.clock);
  const types = m.launcher.made[1].received.map((x) => x.type);
  assert.ok(types.includes('overlay.want'));
  await m.shell.stop();
});

test('stop() is final: everything after it is refused with stopped', async () => {
  const m = make();
  await m.shell.start();
  m.control('fake.stall');
  const pending = m.shell.os.windows();
  await m.shell.stop();
  await assert.rejects(pending, { code: 'stopped' });
  await m.shell.stop();
  await assert.rejects(m.shell.os.windows(), { code: 'stopped' });
  await assert.rejects(m.shell.control.hotkey('stow', 'Ctrl+Alt+C'), { code: 'stopped' });
  await assert.rejects(m.shell.start(), { code: 'stopped' });
  assert.equal(m.clock.pending, 0);
});