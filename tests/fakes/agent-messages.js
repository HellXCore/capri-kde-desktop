'use strict';

// The catalog, spoken: one valid and one broken payload for every message type, the results a
// request may answer with, and the envelope-level junk a buggy or hostile sender puts on the wire.
// The codec's own tests and the transport contract read this same table, so "every type is covered,
// valid and invalid" is something the runner checks rather than a promise in a comment.

const { CATALOG } = require('../../src/main/platform/agent/protocol');

const RECT = { x: 10, y: 20, w: 300, h: 200 };
const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, w: 1920, h: 1080 },
  workArea: { x: 0, y: 0, w: 1920, h: 1040 },
  scale: 1,
};
const ENV = { server: 'wayland', desktop: 'kde', plasma: 6, ozone: null };
const CAPS = {
  tier: 1, backend: 'kwin', windows: true, pointer: true,
  apps: { list: true, close: true }, hotkey: true,
  screenshot: ['spectacle', 'portal'],
  overlay: { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' },
};
const FRAME = {
  rev: 3, fg: 7, dock: false,
  front: { ai: ['chatgpt'], game: 'Night City' },
  wins: [{ id: 7, rect: { x: 150, y: 120, w: 400, h: 300 }, max: false }],
  self: { x: 100, y: 50, w: 800, h: 600 },
};
const FACT = { kind: 'devices', usb: ['STICK'], plug: { n: 1, in: true, name: 'STICK', class: 'DiskDrive' } };

// `broken` is one field a careless sender gets wrong, everything else left as it is: the refusal
// must come from that field, not from the sample being unusable.
const SAMPLES = {
  hello: {
    payload: { env: ENV, displays: [DISPLAY], overlay: { pid: 4242, title: 'capri-overlay', xid: null } },
    broken: { env: { ...ENV, plasma: 5 }, displays: [DISPLAY], overlay: { pid: 4242, title: 'capri-overlay', xid: null } },
  },
  displays: { payload: { list: [DISPLAY] }, broken: { list: [{ ...DISPLAY, scale: '1' }] } },
  'overlay.want': { payload: { rect: RECT }, broken: { rect: { ...RECT, w: '300' } } },
  'overlay.zones': { payload: { rects: [RECT], dpr: 2 }, broken: { rects: [RECT], dpr: -1 } },
  'overlay.focus': { payload: { on: true }, broken: { on: 'yes' } },
  'overlay.stack': { payload: {}, broken: { raise: true } },
  'hotkey.set': { payload: { id: 'stow', accel: 'Ctrl+Alt+C' }, broken: { id: 'stow' } },
  shutdown: { payload: {}, broken: { force: true } },
  'os.windows': { payload: {}, broken: { all: true } },
  'os.launchables': { payload: {}, broken: { all: true } },
  'os.launch': { payload: { id: 'org.mozilla.firefox' }, broken: { id: 42 } },
  'os.media': { payload: { action: 'pause' }, broken: { action: 'stop' } },
  'os.search': { payload: { query: 'report' }, broken: { query: null } },
  'os.screenshot': { payload: { display: DISPLAY, multi: false }, broken: { display: DISPLAY, multi: 'no' } },
  'os.terminal': { payload: { command: ['konsole', '-e', 'htop'] }, broken: { command: 'konsole' } },
  'control.closeApps': { payload: { names: ['firefox'], force: false }, broken: { names: 'firefox', force: false } },
  'observe.workArea': { payload: { displayId: 1 }, broken: { displayId: 1.5 } },
  ready: { payload: { proto: 1, caps: CAPS }, broken: { proto: 2, caps: CAPS } },
  health: { payload: { state: 'degraded', reason: 'the session bus is gone' }, broken: { state: 'failed' } },
  beat: { payload: { t: 1234.5 }, broken: { t: 'now' } },
  frame: { payload: FRAME, broken: { ...FRAME, fg: -1 } },
  pointer: { payload: { x: 100, y: 200 }, broken: { x: 100 } },
  fact: { payload: FACT, broken: { ...FACT, plug: { n: 1, in: true, name: 'STICK' } } },
  'overlay.actual': { payload: { rect: RECT }, broken: { rect: null } },
  hotkey: { payload: { id: 'stow' }, broken: { id: 7 } },
  log: { payload: { level: 'info', msg: 'the backend came up' }, broken: { level: 'trace', msg: 'x' } },
};

// What a request answers with. The port leaves these shapes open, so the wire only asks for JSON:
// a picture travels as base64, never as a Buffer.
const RESULTS = {
  'os.windows': [],
  'os.launchables': [],
  'os.launch': null,
  'os.media': true,
  'os.search': ['/home/u/report.pdf'],
  'os.screenshot': 'iVBORw0KGgo=',
  'os.terminal': true,
  'control.closeApps': { running: false },
  'observe.workArea': { x: 0, y: 32, w: 1920, h: 1048 },
};

const envelopeOf = (type, payload) => {
  const entry = CATALOG[type];
  const env = { kind: entry.kind, type, payload };
  if (entry.kind === 'req') env.id = 7;
  return env;
};

// Every message worth sending: the catalog itself, and both shapes of a reply to each request.
const CASES = [
  ...Object.keys(CATALOG).map((type) => ({ name: type, env: envelopeOf(type, SAMPLES[type].payload) })),
  ...Object.keys(RESULTS).flatMap((type) => [
    { name: `res ${type}`, env: { kind: 'res', type, id: 7, payload: RESULTS[type] } },
    { name: `res ${type} (err)`, env: { kind: 'res', type, id: 7, err: { code: 'not-found', msg: 'no such app' } } },
  ]),
];

// Envelope-level junk. All of it is an object: the non-object shapes below never reach a channel,
// they are refused by the codec before anything could be sent.
const WIRE_JUNK = [
  { name: 'a newer protocol', code: 'version', raw: { v: 2, kind: 'evt', type: 'beat', payload: { t: 1 } } },
  { name: 'the version as a string', code: 'version', raw: { v: '1', kind: 'evt', type: 'beat', payload: { t: 1 } } },
  { name: 'no version at all', code: 'version', raw: { kind: 'evt', type: 'beat', payload: { t: 1 } } },
  { name: 'an unknown type', code: 'unknown', raw: { v: 1, kind: 'evt', type: 'nope', payload: {} } },
  { name: 'a prototype name as the type', code: 'unknown', raw: { v: 1, kind: 'evt', type: 'constructor', payload: {} } },
  { name: '__proto__ as the type', code: 'unknown', raw: { v: 1, kind: 'evt', type: '__proto__', payload: {} } },
  { name: 'the type as a number', code: 'unknown', raw: { v: 1, kind: 'evt', type: 42, payload: {} } },
  { name: 'an event sent as a command', code: 'invalid', raw: { v: 1, kind: 'cmd', type: 'beat', payload: { t: 1 } } },
  { name: 'a reply to an event', code: 'invalid', raw: { v: 1, kind: 'res', type: 'beat', id: 1, payload: {} } },
  { name: 'no kind', code: 'invalid', raw: { v: 1, type: 'beat', payload: { t: 1 } } },
  { name: 'an extra envelope key', code: 'invalid', raw: { v: 1, kind: 'evt', type: 'beat', payload: { t: 1 }, extra: true } },
  { name: 'an id on an event', code: 'invalid', raw: { v: 1, kind: 'evt', type: 'beat', id: 1, payload: { t: 1 } } },
  { name: 'a request without an id', code: 'invalid', raw: { v: 1, kind: 'req', type: 'os.media', payload: { action: 'pause' } } },
  { name: 'a request id as a string', code: 'invalid', raw: { v: 1, kind: 'req', type: 'os.media', id: '7', payload: { action: 'pause' } } },
  { name: 'an error on an event', code: 'invalid', raw: { v: 1, kind: 'evt', type: 'log', payload: { level: 'info', msg: 'x' }, err: { code: 'x', msg: 'y' } } },
  { name: 'a reply with both a result and an error', code: 'invalid', raw: { v: 1, kind: 'res', type: 'os.launch', id: 1, payload: null, err: { code: 'x', msg: 'y' } } },
  { name: 'an error without a message', code: 'invalid', raw: { v: 1, kind: 'res', type: 'os.launch', id: 1, err: { code: 'x' } } },
  { name: 'a payload that is not an object', code: 'invalid', raw: { v: 1, kind: 'evt', type: 'beat', payload: 5 } },
  { name: 'an extra payload key', code: 'invalid', raw: { v: 1, kind: 'evt', type: 'beat', payload: { t: 1, extra: 1 } } },
];

const REFUSED = [
  ...Object.keys(CATALOG).map((type) => ({
    name: `${type}: a broken payload`,
    code: 'invalid',
    raw: { v: 1, ...envelopeOf(type, SAMPLES[type].broken) },
  })),
  ...WIRE_JUNK,
];

const SHAPES = [null, undefined, 42, 'beat', [], true];

module.exports = { SAMPLES, RESULTS, CASES, REFUSED, SHAPES, RECT, DISPLAY, ENV, FRAME, FACT };
