'use strict';

// AgentShell: the DesktopShell port over the platform agent's wire (protocol v1). Nothing here
// knows what a compositor, an X server or D-Bus is: it sends the catalog's messages, keeps the
// answers pending, and turns the agent's events into the port's observables.
//
// The agent is a component under supervise(). A transport that closes is a failure like any other:
// the requests in flight are refused with 'agent-restarted', the process comes back after a backoff,
// and everything the host asked for is replayed on the next `ready` — no caller sees the restart.
//
// Two facts are static, decided by the host before the agent is launched: the backend and its tier
// (`expected`, the same policy the agent applies to EnvFacts). An agent reporting a different one,
// or speaking a protocol version this build does not, is a build mismatch: 'failed', no retry loop.

const { PROTO, createCodec, encode } = require('../agent/protocol');
const { supervise } = require('../../core/supervisor');
const { v } = require('../../core/validate');
const { createDesiredState } = require('./state');

/** @typedef {import('../../core/ports').Capabilities} Capabilities */
/** @typedef {import('../../core/ports').DesktopShell} DesktopShell */
/** @typedef {import('../../core/ports').DipRect} DipRect */
/** @typedef {import('../../core/ports').Clock} Clock */
/** @typedef {import('../../core/ports').Logger} Logger */
/** @typedef {import('../../core/env').EnvFacts} EnvFacts */
/** @typedef {import('../agent/protocol').Envelope} Envelope */
/** @typedef {import('../agent/protocol').Transport} Transport */
/** @typedef {import('../../core/validate').Validator<any>} Check */
/** @typedef {{ transport: Transport, kill(): void }} AgentHandle */
/** @typedef {{ start(entry: string): Promise<AgentHandle> }} AgentLauncher */
/** @typedef {Error & { code: string }} Refusal */

const REQUEST_TIMEOUT_MS = 5000;
const BEAT_TIMEOUT_MS = 6000;

/** @param {string} code @param {string} msg @returns {Refusal} */
const failure = (code, msg) => Object.assign(new Error(msg), { code });
const stoppedError = () => failure('stopped', 'the shell is stopped');
const unavailable = () => failure('agent-unavailable', 'the platform agent is not ready');

/** @template T @param {import('../../core/validate').Validator<T>} inner @returns {import('../../core/validate').Validator<T | null>} */
const nullable = (inner) => (value, path) => (value === null ? null : inner(value, path));

// The answers whose shape the port pins. The rest (os.windows, os.launchables, os.launch) are
// opaque there, and the codec has already bounded them as JSON. A picture travels as base64.
const rect = v.obj({ x: v.num(), y: v.num(), w: v.num(), h: v.num() });
/** @type {Record<string, Check>} */
const RESULTS = {
  'os.media': v.bool(),
  'os.terminal': v.bool(),
  'os.search': v.arr(v.str(), { max: 1024 }),
  'os.screenshot': nullable(v.str()),
  'control.closeApps': v.obj({ running: v.bool() }),
  'observe.workArea': nullable(rect),
};

/** @param {Capabilities} c @returns {Capabilities} */
const copy = (c) => ({ ...c, apps: { ...c.apps }, screenshot: [...c.screenshot], overlay: { ...c.overlay } });

// Subscribers hear values synchronously, in subscription order, over a snapshot of the list; last()
// replays the newest value so a late subscriber can catch up. Subscribing itself never replays.
function observable() {
  /** @type {Set<(value: any) => void>} */
  const subs = new Set();
  /** @type {any} */ let last;
  return {
    /** @param {(value: any) => void} fn */
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    last: () => last,
    /** @param {any} value */
    publish(value) { last = value; for (const fn of [...subs]) fn(value); },
    clear() { subs.clear(); },
  };
}

/**
 * @param {{
 *   launcher: AgentLauncher, entry: string, env: EnvFacts, expected: Capabilities,
 *   clock: Clock, log: Logger, policy?: import('../../core/supervisor').Policy,
 *   requestTimeoutMs?: number, beatTimeoutMs?: number,
 * }} o
 * @returns {DesktopShell}
 */
function createAgentShell({
  launcher, entry, env, expected, clock, log, policy,
  requestTimeoutMs = REQUEST_TIMEOUT_MS, beatTimeoutMs = BEAT_TIMEOUT_MS,
}) {
  const codec = createCodec({ log });
  const wish = createDesiredState({ env });
  const health = observable();
  const frames = observable();
  const pointer = observable();
  const facts = observable();
  const onHotkey = observable();
  health.publish({ state: 'idle' });

  /** @type {AgentHandle|null} */ let current = null;
  let live = false;              // the agent has said ready
  let done = false;              // stop() said once
  /** @type {Refusal|null} */ let fatal = null;
  /** @type {string|null} */ let agentReason = null; // the agent's own degraded reason
  /** @type {string|null} */ let why = null;         // the supervisor's last reason
  /** @type {Capabilities|null} */ let reported = null;
  /** @type {any} */ let beatTimer = null;
  /** @type {Promise<void>|null} */ let started = null;
  /** @type {{ resolve: (v?: any) => void, reject: (e: any) => void }|null} */ let firstReady = null;
  let nextId = 1;
  /** @type {Map<number, { type: string, resolve: (v: any) => void, reject: (e: any) => void, timer: any }>} */
  const pending = new Map();
  /** @type {Set<{ rect: DipRect, resolve: (r: DipRect) => void, reject: (e: any) => void, timer: any }>} */
  const placing = new Set();

  const publish = () => {
    if (fatal) return health.publish({ state: 'failed', reason: fatal.message });
    const state = sup.state();
    if (state === 'ready' && agentReason) return health.publish({ state: 'degraded', reason: agentReason });
    health.publish(why ? { state, reason: why } : { state });
  };

  /** @param {Refusal} err */
  const rejectAll = (err) => {
    for (const p of pending.values()) { clock.clearTimeout(p.timer); p.reject(err); }
    pending.clear();
    for (const w of placing) { clock.clearTimeout(w.timer); w.reject(err); }
    placing.clear();
  };

  const clearBeat = () => { if (beatTimer !== null) clock.clearTimeout(beatTimer); beatTimer = null; };
  const armBeat = () => {
    clearBeat();
    beatTimer = clock.setTimeout(() => { beatTimer = null; lost(`no beat for ${beatTimeoutMs} ms`); }, beatTimeoutMs);
  };

  const detach = () => { current = null; live = false; clearBeat(); };

  // The channel went away under us: the process is restarted by the supervisor, and what was in
  // flight is refused with a code that says why (a caller may retry; the wishes are replayed).
  /** @param {string} reason */
  const lost = (reason) => {
    if (!current || done || fatal) return;
    detach();
    rejectAll(failure('agent-restarted', `the platform agent went away (${reason})`));
    sup.failed(new Error(reason));
  };

  // A refusal retrying cannot fix. Said once, and the lifecycle is over.
  /** @param {Refusal} err */
  const refuse = (err) => {
    if (fatal || done) return;
    fatal = err;
    log.error(`agent: ${err.message}`);
    rejectAll(err);
    firstReady?.reject(err);
    firstReady = null;
    void stop();
  };

  /** @param {string} type @param {Record<string, unknown>} payload @returns {boolean} */
  const post = (type, payload) => {
    const h = current;
    if (!h || done || fatal) return false;
    try {
      h.transport.send(encode({ kind: 'cmd', type, payload }));
      return true;
    } catch (err) {
      log.warn(`agent: ${type} refused: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  /** @param {string} type @param {Record<string, unknown>} payload @returns {Promise<any>} */
  const request = (type, payload) => {
    if (fatal) return Promise.reject(fatal);
    if (done) return Promise.reject(stoppedError());
    const h = current;
    if (!h || !live) return Promise.reject(unavailable());
    return /** @type {Promise<any>} */ (new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = clock.setTimeout(() => {
        pending.delete(id);
        reject(failure('timeout', `${type}: no answer in ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      pending.set(id, { type, resolve, reject, timer });
      try {
        h.transport.send(encode({ kind: 'req', type, id, payload }));
      } catch (err) {
        pending.delete(id);
        clock.clearTimeout(timer);
        reject(failure('invalid', `${type}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }));
  };

  // Placement is asked for, then confirmed by the compositor's own answer — never assumed.
  /** @param {DipRect} r @returns {Promise<DipRect>} */
  const place = (r) => {
    wish.setWant(r);
    if (fatal) return Promise.reject(fatal);
    if (done) return Promise.reject(stoppedError());
    if (!current || !live) return Promise.reject(unavailable());
    const want = { ...r };
    return /** @type {Promise<DipRect>} */ (new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        placing.delete(waiter);
        reject(failure('timeout', 'overlay.want: the place was never confirmed'));
      }, requestTimeoutMs);
      const waiter = { rect: want, resolve, reject, timer };
      placing.add(waiter);
      if (!post('overlay.want', { rect: want })) {
        placing.delete(waiter);
        clock.clearTimeout(timer);
        reject(unavailable());
      }
    }));
  };

  /** @param {DipRect} confirmed */
  const confirm = (confirmed) => {
    for (const w of [...placing]) {
      const r = w.rect;
      if (r.x !== confirmed.x || r.y !== confirmed.y || r.w !== confirmed.w || r.h !== confirmed.h) continue;
      placing.delete(w);
      clock.clearTimeout(w.timer);
      w.resolve(confirmed);
    }
  };

  /** @param {Envelope} msg */
  const answer = (msg) => {
    const id = msg.id ?? 0;
    const p = pending.get(id);
    if (!p) return; // a reply to a request already given up on
    pending.delete(id);
    clock.clearTimeout(p.timer);
    if (msg.err) return p.reject(failure(msg.err.code, msg.err.msg));
    /** @type {any} */ let value = msg.payload ?? null;
    const check = RESULTS[p.type];
    if (check) {
      try { value = check(value, 'result'); } catch (err) {
        return p.reject(failure('invalid-result', `${p.type}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    p.resolve(p.type === 'os.screenshot' && value !== null ? Buffer.from(String(value), 'base64') : value);
  };

  /** @param {Envelope} msg */
  const event = (msg) => {
    const payload = /** @type {any} */ (msg.payload || {});
    switch (msg.type) {
      case 'ready': {
        if (payload.caps.backend !== expected.backend || payload.caps.tier !== expected.tier) {
          return refuse(failure('backend-mismatch',
            `the agent runs the ${payload.caps.backend} backend, this build expects ${expected.backend}`));
        }
        reported = payload.caps;
        live = true;
        agentReason = null;
        wish.replay(post);
        armBeat();
        const was = sup.state();
        sup.healthy();
        if (was === 'ready') publish();
        firstReady?.resolve();
        firstReady = null;
        return;
      }
      case 'health':
        agentReason = payload.state === 'degraded' ? (payload.reason || 'the agent is degraded') : null;
        return publish();
      case 'beat': return armBeat();
      case 'frame': return frames.publish(payload);
      case 'pointer': return pointer.publish(payload);
      case 'fact': return facts.publish(payload);
      case 'hotkey': return onHotkey.publish(payload.id);
      case 'overlay.actual': return confirm(payload.rect);
      case 'log': return log[/** @type {'debug'|'info'|'warn'|'error'} */ (payload.level)](payload.msg);
      default: return;
    }
  };

  /** @param {unknown} raw */
  const onMessage = (raw) => {
    if (!current) return;
    // A peer speaking another version is a build error, not junk to drop and carry on with.
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'v' in raw && raw.v !== PROTO) {
      return refuse(failure('protocol-version', `the agent speaks protocol ${String(raw.v)}, this build speaks ${PROTO}`));
    }
    const msg = codec.read(raw);
    if (!msg) return;
    if (msg.kind === 'res') return answer(msg);
    if (msg.kind === 'evt') return event(msg);
    // a host-bound command echoed back: the catalog's kinds keep everything else out
  };

  /** @param {AgentHandle} h */
  const attach = (h) => {
    current = h;
    h.transport.onMessage(onMessage);
    h.transport.onClose((reason) => { if (current === h) lost(reason || 'the transport closed'); });
    wish.hello(post);
  };

  const sup = supervise({
    name: 'agent',
    clock,
    log,
    policy,
    start: async () => {
      const h = await launcher.start(entry);
      if (done || fatal) { h.kill(); throw stoppedError(); }
      attach(h);
      return h;
    },
    stop: async (h) => { h.transport.close(); h.kill(); },
  });
  sup.on((state, reason) => {
    why = reason ?? null;
    if (state !== 'ready') agentReason = null;
    publish();
  });

  const teardown = () => { for (const o of [health, frames, pointer, facts, onHotkey]) o.clear(); };

  const stop = async () => {
    if (done) return;
    done = true;
    detach();
    rejectAll(fatal || stoppedError());
    firstReady?.reject(fatal || stoppedError());
    firstReady = null;
    await sup.stop(); // 'stopped' (or 'failed') is heard before the subscribers go
    teardown();
  };

  // Resolves once the agent is up and has said ready; rejects if it can never be (fatal, stopped).
  const start = () => {
    if (done) return Promise.reject(stoppedError());
    if (started) return started;
    const p = /** @type {Promise<void>} */ (new Promise((resolve, reject) => { firstReady = { resolve, reject }; }));
    started = p;
    sup.start();
    return p;
  };

  return {
    caps: () => copy(reported || expected),
    health,
    observe: {
      frames, pointer, facts,
      workArea: (displayId) => request('observe.workArea', { displayId }),
    },
    overlay: {
      request: (r) => place(r),
      raise: () => { post('overlay.stack', {}); },
      focus: (on) => { wish.setFocus(on); post('overlay.focus', { on: Boolean(on) }); },
      zones: (z) => { wish.setZones(z); post('overlay.zones', { rects: z.rects, dpr: z.dpr }); },
      identity: (i) => { wish.setIdentity(i); },
    },
    control: {
      // hotkey.set is a command in the catalog: the boolean is the platform's declared ability to
      // own a global hotkey, not a registration receipt. The wish is replayed on every ready.
      hotkey: (id, accel) => {
        if (fatal) return Promise.reject(fatal);
        if (done) return Promise.reject(stoppedError());
        if (!expected.hotkey) return Promise.resolve(false);
        wish.setHotkey(id, accel);
        post('hotkey.set', { id, accel });
        return Promise.resolve(true);
      },
      onHotkey,
      closeApps: (names, o) => request('control.closeApps', { names, force: Boolean(o?.force) }),
    },
    os: {
      windows: () => request('os.windows', {}),
      launchables: () => request('os.launchables', {}),
      launch: (id) => request('os.launch', { id }),
      media: (action) => request('os.media', { action }),
      search: (query) => request('os.search', { query }),
      screenshot: (o) => request('os.screenshot', { display: o.display, multi: o.multi }),
      terminal: (command) => request('os.terminal', { command }),
    },
    setDisplays: (list) => { wish.setDisplays(list); post('displays', { list }); },
    start,
    stop,
  };
}

module.exports = { createAgentShell, REQUEST_TIMEOUT_MS, BEAT_TIMEOUT_MS };
