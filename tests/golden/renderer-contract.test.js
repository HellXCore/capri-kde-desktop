'use strict';

// The renderer contract (docs/renderer-contract.md) pinned against the code that produces each
// push channel: the documented examples must carry exactly the fields main actually sends, and
// the documented subscriptions must be preload's. A failure means the document and the code
// drifted apart — decide which one is wrong on purpose, do not just edit the expectation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'renderer-contract.md'), 'utf8');

const { toRendererPayload } = require('../../src/main/platform/shell/frames');
const { createOverlayController } = require('../../src/main/app/overlay-window');
const { createFakeShell } = require('../fakes/fake-shell');
const { createFakeWindow } = require('../fakes/fake-window');
const { createFakeClock } = require('../fakes/fake-clock');
const { watchPower } = require('../../src/main/power');
const { availability, rendererCaps } = require('../../src/main/core/availability');
const { DEFAULTS } = require('../../src/main/config');
const { createBridge } = require('../../src/main/bridge');

const CHANNELS = ['windows:update', 'overlay:resize', 'capri:config', 'power:state', 'claude:event'];
const silent = { log() {}, warn() {}, error() {} };
const keys = (o) => Object.keys(o).sort();

// One section per "## <channel>" heading; deeper headings stay inside their section.
const sections = new Map();
for (const part of DOC.split(/^## /m).slice(1)) {
  sections.set(part.slice(0, part.indexOf('\n')).trim(), part);
}

function example(channel) {
  const m = /```json\n([\s\S]*?)\n```/.exec(sections.get(channel) || '');
  assert.ok(m, `${channel}: a JSON example with every top-level key`);
  return JSON.parse(m[1]);
}

test('the contract covers the five push channels, each with when/units/frequency and an example', () => {
  for (const ch of CHANNELS) {
    const s = sections.get(ch);
    assert.ok(s, `the contract documents ${ch}`);
    for (const marker of ['**Когда:**', '**Частота:**', '**Единицы:**']) {
      assert.ok(s.includes(marker), `${ch}: ${marker}`);
    }
  }
});

test('the documented subscriptions are the ones preload wires', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  const wired = {};
  for (const m of preload.matchAll(/(\w+): on\('([^']+)'\)/g)) wired[m[2]] = m[1];
  for (const ch of CHANNELS) {
    // The line's decoration (bold, backticks, spacing) is not the contract; the method it names is.
    const m = /Подписка:[^\n]*host\.(\w+)/.exec(sections.get(ch));
    assert.ok(m, `${ch}: a subscription line`);
    assert.equal(m[1], wired[ch], ch);
  }
});

test('windows:update: the example is exactly what the projection produces', () => {
  const frame = {
    rev: 3, fg: 7, dock: false, front: { ai: ['chatgpt'], game: 'Night City' },
    wins: [{ id: 7, rect: { x: 150, y: 120, w: 400, h: 300 }, max: false }],
    self: { x: 100, y: 50, w: 800, h: 600 },
  };
  const devices = { usb: ['STICK'], plug: { n: 1, in: true, name: 'STICK', class: 'DiskDrive' } };
  const payload = toRendererPayload(frame, { x: 100, y: 50, width: 800, height: 600 }, devices);
  const doc = example('windows:update');
  assert.deepEqual(doc, payload);
  assert.equal('rev' in doc, false); // the revision is main's, never the renderer's
});

test('overlay:resize: the example is exactly what the controller reports on a fit', () => {
  const clock = createFakeClock();
  const fake = createFakeShell();
  const sizes = [];
  const ctl = createOverlayController({
    BrowserWindow: function (opts) { return createFakeWindow(opts).win; },
    shell: fake.shell, clock, log: silent,
    areaOf: () => ({ area: { x: 0, y: 0, width: 1920, height: 1079 }, gap: 40 }),
    onResize: (s) => sizes.push(s),
    defer: (fn) => clock.setTimeout(fn, 0),
  });
  ctl.create({ preload: 'p', url: 'u' });
  ctl.fit();
  assert.deepEqual(example('overlay:resize'), sizes.at(-1));
  ctl.close();
  assert.equal(clock.pending, 0);
});

test('power:state: the example is exactly the watcher state on a lock', () => {
  const power = new EventEmitter();
  const seen = [];
  const watch = watchPower({ power, onChange: (s) => seen.push(s), log() {} });
  power.emit('lock-screen');
  assert.deepEqual(example('power:state'), seen.at(-1));
  power.emit('unlock-screen');
  assert.deepEqual(seen.at(-1), { away: false, why: [] });
  watch.stop();
});

test('capri:config: the documented keys are the config snapshot main sends, without the secrets', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
  const at = src.indexOf('function rendererConfig()');
  assert.ok(at >= 0);
  const fn = src.slice(at, src.indexOf('\n}', at));
  assert.match(fn, /const \{ apiKeys, \.\.\.cfg \} = config\.load\(\)/); // keys never leave main
  const ret = /return \{ \.\.\.cfg, (.+) \};/.exec(fn);
  assert.ok(ret, 'rendererConfig returns the config spread plus named additions');
  const added = [...ret[1].matchAll(/([A-Za-z_]\w*):/g)].map((m) => m[1]);
  const want = [...new Set([...Object.keys(DEFAULTS).filter((k) => k !== 'apiKeys'), ...added])];
  const doc = example('capri:config');
  assert.deepEqual(keys(doc), want.sort());
  assert.equal('apiKeys' in doc, false);
  // the capabilities cell is the renderer vocabulary, generated from availability
  const report = {
    tier: 1, backend: 'kwin', windows: true, pointer: true,
    apps: { list: true, close: true }, hotkey: true, screenshot: [],
    overlay: { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' },
  };
  assert.deepEqual(keys(doc.caps), keys(rendererCaps(availability(report, 'ready'))));
});

test('claude:event: the documented vocabulary is the hook\'s trimmed one, plus the demo flag', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'capri-hook.js'), 'utf8');
  const keep = /const KEEP = \[([\s\S]*?)\];/.exec(hook);
  assert.ok(keep, 'the hook declares its field vocabulary');
  const fields = [...keep[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys(example('claude:event')), [...fields, 'demo'].sort());
});

test('claude:event: the bridge admits a valid hook event and refuses anything else', async (t) => {
  const events = [];
  const server = createBridge({ port: 0, onEvent: (e) => events.push(e) });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const post = (body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/event', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await post(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' })), 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].hook_event_name, 'Stop');
  for (const bad of ['null', '[]', '{}', '{"hook_event_name":5}', 'not json']) {
    assert.equal(await post(bad), 400, bad);
  }
  assert.equal(events.length, 1); // nothing invalid was handed on, nothing was "repaired"
});
