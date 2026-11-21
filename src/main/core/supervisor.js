'use strict';

// One component's life cycle: start it, wait for it to come up, and when it fails, start it again
// after a wait that grows with every consecutive failure. A failure is a state with a retry
// scheduled, never a flag that stops the world: the last backoff step simply repeats. Time comes
// from the clock handed in, so a test moves it by hand instead of sleeping through it.
//
//   idle      --start()----------->  starting   the attempt is out, its deadline armed
//   starting  --up / healthy()---->  ready      deadline dropped, the stability window opens
//   starting  --error / timeout--->  degraded   a retry is scheduled
//   ready     --failed(err)------->  degraded   the component is stopped, a retry is scheduled
//   degraded  --retry due--------->  starting
//   any       --stop()------------>  stopped    timers dropped, the component stopped
//
// Two things the table cannot show:
//   - every attempt carries a ticket. What settles after the attempt was disowned (a timeout, a
//     stop) is not adopted: a component that arrives late is stopped, so nothing outlives us.
//   - stop() is final. This object is one life cycle; starting again means making a new one. That
//     is a deliberate end, not a failure, so it is the only state nothing retries from.

/** @typedef {import('./ports').AgentState} State */
/** @typedef {{ backoffMs: readonly number[], stableAfterMs: number, startTimeoutMs: number }} Policy */

/** @type {Policy} */
const DEFAULT_POLICY = Object.freeze({
  backoffMs: Object.freeze([250, 1000, 4000, 15000, 60000]),
  stableAfterMs: 60000, // this long in ready and the failure count is forgotten
  startTimeoutMs: 8000, // not up by then: the attempt failed
});

/**
 * @template H
 * @param {{ name: string, start: () => Promise<H>, stop: (h: H) => Promise<void>,
 *           policy?: Policy, clock: import('./ports').Clock, log: import('./ports').Logger }} o
 * @returns {{ state: () => State, on: (fn: (s: State, why?: string) => void) => () => void,
 *             start: () => void, stop: () => Promise<void>, healthy: () => void,
 *             failed: (err: Error) => void }}
 */
function supervise(o) {
  const { name, clock, log } = o;
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('supervise: a name is required');
  if (typeof o.start !== 'function' || typeof o.stop !== 'function') throw new TypeError('supervise: start and stop must be functions');
  if (!clock || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') throw new TypeError('supervise: a clock is required');
  const policy = { ...DEFAULT_POLICY, ...o.policy };
  const steps = policy.backoffMs.length ? policy.backoffMs : DEFAULT_POLICY.backoffMs;

  /** @type {State} */
  let state = 'idle';
  /** @type {H | null} */
  let handle = null;
  let attempt = 0; // consecutive failures: which backoff step comes next
  let ticket = 0;  // the attempt in flight; bumped to disown one
  /** @type {any} */ let startTimer = null;
  /** @type {any} */ let retryTimer = null;
  /** @type {any} */ let stableTimer = null;
  /** @type {Array<{ fn: (s: State, why?: string) => void }>} */
  const listeners = [];

  /** @param {unknown} err */
  const message = (err) => (err instanceof Error ? err.message : String(err));

  /** @param {any} h */
  const clear = (h) => { if (h !== null) clock.clearTimeout(h); return null; };
  const dropTimers = () => {
    startTimer = clear(startTimer);
    retryTimer = clear(retryTimer);
    stableTimer = clear(stableTimer);
  };

  // Where it ended up: a listener has its say synchronously and may move it on (stop it, fail it)
  // before this returns, so the caller is told instead of reading the variable back.
  /** @param {State} next @param {string} [why] @returns {State} */
  const enter = (next, why) => {
    state = next;
    for (const entry of listeners.slice()) {
      if (!listeners.includes(entry)) continue; // unsubscribed by a listener before it
      try { entry.fn(next, why); } catch (err) { log.error(`${name}: state listener threw: ${message(err)}`); }
    }
    return state;
  };

  // Tearing it down is best effort: a component that cannot be stopped cleanly is still gone from
  // here, and the failure is said out loud rather than thrown at whoever asked for the stop.
  /** @param {H} h */
  const stopHandle = async (h) => {
    try { await o.stop(h); } catch (err) { log.error(`${name}: stop failed: ${message(err)}`); }
  };

  // Up: the deadline is dropped and the window opens after which the failures are forgotten. It
  // runs from the moment it came up; a later confirmation does not move it.
  const up = () => {
    if (state === 'ready') return;
    startTimer = clear(startTimer);
    log.info(`${name}: ready`);
    if (enter('ready') !== 'ready') return; // a listener took it somewhere else on the way out
    stableTimer = clock.setTimeout(() => {
      stableTimer = null;
      attempt = 0;
      log.debug(`${name}: stable, the failure count is forgotten`);
    }, policy.stableAfterMs);
  };

  /** @param {unknown} err */
  const degrade = (err) => {
    ticket += 1; // the attempt in flight, if any, is no longer ours
    dropTimers();
    const h = handle;
    handle = null;
    const why = message(err);
    const wait = steps[Math.min(attempt, steps.length - 1)];
    attempt += 1;
    log.warn(`${name}: ${why} (retry ${attempt} in ${wait} ms)`);
    if (h !== null) void stopHandle(h);
    // The retry is on the clock either way: a stop that never finishes must not strand it here.
    if (enter('degraded', why) === 'degraded') retryTimer = clock.setTimeout(() => { retryTimer = null; attemptStart(); }, wait);
  };

  const attemptStart = () => {
    const id = ++ticket;
    enter('starting');
    if (id !== ticket) return; // a listener stopped it on the way out
    log.debug(`${name}: starting (attempt ${attempt + 1})`);
    startTimer = clock.setTimeout(() => {
      startTimer = null;
      if (id === ticket) degrade(new Error(`start timed out after ${policy.startTimeoutMs} ms`));
    }, policy.startTimeoutMs);
    /** @type {Promise<H>} */
    let begun;
    try { begun = Promise.resolve(o.start()); } catch (err) { begun = Promise.reject(err); }
    begun.then(
      (h) => {
        if (id !== ticket) { void stopHandle(h); return; } // arrived late: stopped, not adopted
        startTimer = clear(startTimer);
        handle = h;
        up();
      },
      (err) => { if (id === ticket) degrade(err); },
    );
  };

  const start = () => {
    if (state !== 'idle') { log.debug(`${name}: start ignored (${state})`); return; }
    attemptStart();
  };

  const stop = async () => {
    if (state === 'stopped') return;
    ticket += 1;
    dropTimers();
    const h = handle;
    handle = null;
    enter('stopped');
    if (h !== null) await stopHandle(h);
  };

  // It says it is up itself (a handshake, a first frame) before start() has resolved.
  const healthy = () => { if (state === 'starting') up(); };

  // It went bad: a beat missed, the transport closed. A word from an instance already given up on
  // arrives after that and is ignored: it must not push the retry back or stop it a second time.
  /** @param {Error} err */
  const failed = (err) => { if (state === 'ready' || state === 'starting') degrade(err); };

  /** @param {(s: State, why?: string) => void} fn */
  const on = (fn) => {
    if (typeof fn !== 'function') throw new TypeError('supervise.on: a function is required');
    const entry = { fn };
    listeners.push(entry);
    return () => {
      const i = listeners.indexOf(entry);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  return { state: () => state, on, start, stop, healthy, failed };
}

module.exports = { supervise, DEFAULT_POLICY };