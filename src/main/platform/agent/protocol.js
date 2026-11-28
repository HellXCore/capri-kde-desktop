'use strict';

// The wire between the host and the platform agent: one envelope, one catalog, one validation path.
// Every message is JSON-compatible and carries the protocol version; a mismatch is a build error,
// not a situation to negotiate. The catalog is the single source of truth: each type names its
// kind, its direction and the check its payload must pass. Anything crossing this boundary is
// validated on entry and refused as a whole when it fails — never repaired field by field.

const { v, ValidationError } = require('../../core/validate');

const PROTO = 1;

/** @typedef {{ v: 1, kind: 'evt'|'cmd'|'req'|'res', type: string, id?: number, payload?: unknown, err?: { code: string, msg: string } }} Envelope */

// The pipe itself: it carries envelopes and hands raw values back; decoding is the reader's job.
/** @typedef {{ send(msg: Envelope): void, onMessage(fn: (msg: unknown) => void): void, onClose(fn: (reason?: string) => void): void, close(): void }} Transport */

/** @typedef {import('../../core/validate').Validator<unknown>} Check */
/** @typedef {{ kind: 'cmd'|'req'|'evt', dir: 'host-to-agent'|'agent-to-host', payload: import('../../core/validate').Validator<Record<string, unknown>> }} Entry */

class ProtocolError extends Error {
  /** @param {string} code @param {string} msg */
  constructor(code, msg) {
    super(msg);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** @template T @param {() => T} run @returns {T} */
const checked = (run) => {
  try { return run(); } catch (err) {
    throw new ProtocolError('invalid', err instanceof Error ? err.message : String(err));
  }
};

/** @template T @param {import('../../core/validate').Validator<T>} inner @returns {import('../../core/validate').Validator<T | null>} */
const nullable = (inner) => (value, path) => (value === null ? null : inner(value, path));

// Opaque results (the os.* answers, whose shapes the ports do not pin) still cross a trust
// boundary: they must be plain JSON, and bounded, so a hostile sender cannot make the reader
// walk without end.
const LIMITS = { depth: 8, string: 4 * 1024 * 1024, items: 1024, keys: 128 };

/** @param {unknown} value @param {string} path @param {number} depth @returns {unknown} */
function jsonAt(value, path, depth) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(path, 'expected a finite number');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > LIMITS.string) throw new ValidationError(path, 'string too long');
    return value;
  }
  if (depth >= LIMITS.depth) throw new ValidationError(path, 'nested too deep');
  if (Array.isArray(value)) {
    if (value.length > LIMITS.items) throw new ValidationError(path, `at most ${LIMITS.items} items`);
    return value.map((item, i) => jsonAt(item, `${path}[${i}]`, depth + 1));
  }
  if (typeof value === 'object') {
    const rec = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(rec);
    if (keys.length > LIMITS.keys) throw new ValidationError(path, `at most ${LIMITS.keys} keys`);
    return Object.fromEntries(keys.map((k) => [k, jsonAt(rec[k], path ? `${path}.${k}` : k, depth + 1)]));
  }
  throw new ValidationError(path, 'not JSON-compatible');
}

/** @type {Check} */
const json = (value, path = '') => jsonAt(value, path, 0);

// ---------- the shapes the catalog speaks ----------

const rect = v.obj({ x: v.num(), y: v.num(), w: v.num(), h: v.num() });
const display = v.obj({ id: v.int(), bounds: rect, workArea: rect, scale: v.num(0) });
const envFacts = v.obj({
  server: v.oneOf(['wayland', 'xwayland', 'x11', 'none']),
  desktop: v.oneOf(['kde', 'other']),
  plasma: nullable(v.oneOf([6])),
  ozone: nullable(v.oneOf(['x11', 'wayland'])),
});
const caps = v.obj({
  tier: v.oneOf([1, 2]),
  backend: v.oneOf(['kwin', 'x11', 'generic']),
  windows: v.bool(),
  pointer: v.bool(),
  apps: v.obj({ list: v.bool(), close: v.bool() }),
  hotkey: v.bool(),
  screenshot: v.arr(v.oneOf(['spectacle', 'portal', 'capturer']), { max: 3 }),
  overlay: v.obj({
    place: v.oneOf(['client', 'compositor']),
    stacking: v.oneOf(['client', 'compositor']),
    focus: v.oneOf(['client', 'compositor']),
    input: v.oneOf(['xshape', 'toggle', 'passthrough']),
  }),
});
const win = v.obj({ id: v.int(0), rect, max: v.bool() });
const frame = v.obj({
  rev: v.int(0),
  fg: v.int(0),
  dock: v.bool(),
  // the game label as the renderer knows it today; its richer shape is not agreed yet
  front: v.obj({ ai: v.arr(v.str({ max: 40 }), { max: 8 }), game: nullable(v.str({ max: 200 })) }),
  wins: v.arr(win, { max: 40 }),
  self: nullable(rect),
});
const plug = v.obj({ n: v.int(0), in: v.bool(), name: v.str({ max: 280 }), class: v.str({ max: 40 }) });
const fact = v.obj({ kind: v.oneOf(['devices']), usb: v.arr(v.str({ max: 280 }), { max: 64 }), plug: nullable(plug) });
const empty = v.obj({});
const idCheck = v.int(0);
const errCheck = v.obj({ code: v.str({ max: 80 }), msg: v.str({ max: 500 }) });

/** @type {Readonly<Record<string, Entry>>} */
const CATALOG = Object.freeze(/** @type {Record<string, Entry>} */ ({
  // host -> agent
  hello: { kind: 'cmd', dir: 'host-to-agent', payload: v.obj({ env: envFacts, displays: v.arr(display, { max: 16 }), overlay: v.obj({ pid: v.int(0), title: v.str({ max: 200 }), xid: nullable(v.int(0)) }) }) },
  displays: { kind: 'cmd', dir: 'host-to-agent', payload: v.obj({ list: v.arr(display, { max: 16 }) }) },
  'overlay.want': { kind: 'cmd', dir: 'host-to-agent', payload: v.obj({ rect }) },
  'overlay.zones': { kind: 'cmd', dir: 'host-to-agent', payload: v.obj({ rects: v.arr(rect, { max: 64 }), dpr: v.num(0) }) },
  'overlay.focus': { kind: 'cmd', dir: 'host-to-agent', payload: v.obj({ on: v.bool() }) },
  'overlay.stack': { kind: 'cmd', dir: 'host-to-agent', payload: empty },
  'hotkey.set': { kind: 'cmd', dir: 'host-to-agent', payload: v.obj({ id: v.str({ max: 40 }), accel: v.str({ max: 80 }) }) },
  shutdown: { kind: 'cmd', dir: 'host-to-agent', payload: empty },
  'os.windows': { kind: 'req', dir: 'host-to-agent', payload: empty },
  'os.launchables': { kind: 'req', dir: 'host-to-agent', payload: empty },
  'os.launch': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ id: v.str({ max: 300 }) }) },
  'os.media': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ action: v.oneOf(['play', 'pause', 'next', 'previous', 'volup', 'voldown', 'mute']) }) },
  'os.search': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ query: v.str({ max: 300 }) }) },
  'os.screenshot': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ display, multi: v.bool() }) },
  'os.terminal': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ command: v.arr(v.str({ max: 300 }), { max: 32 }) }) },
  'control.closeApps': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ names: v.arr(v.str({ max: 200 }), { max: 64 }), force: v.bool() }) },
  'observe.workArea': { kind: 'req', dir: 'host-to-agent', payload: v.obj({ displayId: v.int() }) },
  // agent -> host
  ready: { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ proto: v.oneOf([PROTO]), caps }) },
  health: { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ state: v.oneOf(['ready', 'degraded']), reason: v.opt(v.str({ max: 300 })) }) },
  beat: { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ t: v.num() }) },
  frame: { kind: 'evt', dir: 'agent-to-host', payload: frame },
  pointer: { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ x: v.num(), y: v.num() }) },
  fact: { kind: 'evt', dir: 'agent-to-host', payload: fact },
  'overlay.actual': { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ rect }) },
  hotkey: { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ id: v.str({ max: 40 }) }) },
  log: { kind: 'evt', dir: 'agent-to-host', payload: v.obj({ level: v.oneOf(['debug', 'info', 'warn', 'error']), msg: v.str({ max: 2000 }) }) },
}));

const ENVELOPE_KEYS = new Set(['v', 'kind', 'type', 'id', 'payload', 'err']);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The one validation path, both directions. Returns the normalized envelope or throws; a reply
 * (`res`) echoes the type of the request it answers and carries its JSON result, or an `err`.
 * @param {unknown} raw
 * @returns {Envelope}
 */
function decode(raw) {
  if (!isRecord(raw)) throw new ProtocolError('shape', 'not an object');
  if (raw.v !== PROTO) throw new ProtocolError('version', `proto ${String(raw.v)} != ${PROTO}`);
  const type = raw.type;
  if (typeof type !== 'string' || !Object.hasOwn(CATALOG, type)) throw new ProtocolError('unknown', `unknown type ${String(type)}`);
  const entry = CATALOG[type];
  const kind = raw.kind;
  if (kind !== entry.kind && !(kind === 'res' && entry.kind === 'req')) {
    throw new ProtocolError('invalid', `${type}: kind ${String(kind)} does not match ${entry.kind}`);
  }
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.has(key)) throw new ProtocolError('invalid', `unknown key ${key}`);
  }
  const correlated = kind === 'req' || kind === 'res';
  let id = 0;
  if (correlated) id = checked(() => idCheck(raw.id, 'id'));
  else if (raw.id !== undefined) throw new ProtocolError('invalid', `${type}: id is only for req/res`);
  /** @type {{ code: string, msg: string } | undefined} */
  let err;
  if (raw.err !== undefined) {
    if (kind !== 'res') throw new ProtocolError('invalid', `${type}: err is only for res`);
    if (raw.payload !== undefined) throw new ProtocolError('invalid', `${type}: res carries payload or err, not both`);
    err = /** @type {{ code: string, msg: string }} */ (checked(() => errCheck(raw.err, 'err')));
  }
  const payload = kind === 'res'
    ? (err ? undefined : checked(() => json(raw.payload === undefined ? null : raw.payload, 'payload')))
    : checked(() => entry.payload(raw.payload ?? {}, 'payload'));
  /** @type {Envelope} */
  const out = { v: PROTO, kind: /** @type {Envelope['kind']} */ (kind), type };
  if (correlated) out.id = id;
  if (payload !== undefined) out.payload = payload;
  if (err) out.err = err;
  return out;
}

/**
 * The sending side of the same path: a message we build must pass the same checks as one we
 * receive, so a bug here is caught before it ever reaches the wire.
 * @param {{ kind: Envelope['kind'], type: string, payload?: unknown, id?: number, err?: { code: string, msg: string } }} env
 * @returns {Envelope}
 */
function encode(env) {
  return decode({ ...env, v: PROTO });
}

/**
 * The boundary reader: validates, counts and logs what it refuses, and drops it (returns null).
 * The counter is the `protocol.invalid` diagnostic; the log sink is injected, never global.
 * @param {{ log: import('../../core/ports').Logger }} o
 */
function createCodec({ log }) {
  let invalid = 0;
  return {
    /** @param {unknown} raw @returns {Envelope | null} */
    read(raw) {
      try {
        return decode(raw);
      } catch (err) {
        invalid += 1;
        const e = err instanceof ProtocolError ? err : new ProtocolError('invalid', String(err));
        log.warn(`protocol.invalid #${invalid} (${e.code}): ${e.message}`);
        return null;
      }
    },
    encode,
    invalid: () => invalid,
  };
}

module.exports = { PROTO, ProtocolError, CATALOG, decode, encode, createCodec };
