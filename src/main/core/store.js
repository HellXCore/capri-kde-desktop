'use strict';

// A tiny reactive store with named slices. Subscribers watch derived values
// via selectors and are notified synchronously, in subscription order, only
// when the selected value changes.
//
// The store is a factory (R7: no module-level singletons with state). The
// composition root owns the instance and injects the log sink.

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
const defaultEquals = (a, b) => Object.is(a, b);

/**
 * @template {Record<string, any>} S
 * @param {S} initial
 * @param {{ log?: { error?: (msg: string) => void } }} [opts]
 */
function createStore(initial, opts) {
  if (!initial || typeof initial !== 'object') {
    throw new TypeError('createStore: initial state must be an object');
  }
  const sliceNames = new Set(Object.keys(initial));
  /** @type {S} */
  let state = { ...initial };
  /** @type {Array<{ selector: Function, cb: Function, equals: Function, last: unknown }>} */
  const subs = [];
  const log = opts && opts.log ? opts.log : null;

  return {
    /** @returns {S} */
    get() {
      return state;
    },

    /**
     * Shallow-merge a slice. Unknown slice or non-object patch → throw.
     * @param {string} slice
     * @param {object} patch
     */
    update(slice, patch) {
      if (!sliceNames.has(slice)) {
        throw new Error(`createStore.update: unknown slice "${slice}"`);
      }
      if (patch === null || typeof patch !== 'object') {
        throw new TypeError('createStore.update: patch must be an object');
      }
      const current = /** @type {Record<string, unknown>} */ (state[slice]);
      /** @type {Record<string, unknown>} */
      const next = { ...current };
      let changed = false;
      for (const key of Object.keys(patch)) {
        const v = /** @type {Record<string, unknown>} */ (patch)[key];
        if (!Object.is(next[key], v)) {
          next[key] = v;
          changed = true;
        }
      }
      if (!changed) return;
      state = { ...state, [slice]: next };
      notify();
    },

    /**
     * Subscribe to a derived value. Fires synchronously on update, in
     * subscription order, only when the selected value changes. Returns an
     * unsubscribe function.
     * @template V
     * @param {(s: S) => V} selector
     * @param {(v: V) => void} cb
     * @param {{ equals?: (a: V, b: V) => boolean, immediate?: boolean }} [options]
     * @returns {() => void}
     */
    subscribe(selector, cb, options) {
      if (typeof selector !== 'function') throw new TypeError('subscribe: selector must be a function');
      if (typeof cb !== 'function') throw new TypeError('subscribe: cb must be a function');
      const equals = (options && options.equals) || defaultEquals;
      const entry = {
        selector,
        cb,
        equals,
        last: selector(state),
      };
      subs.push(entry);
      if (options && options.immediate) {
        try { cb(entry.last); } catch (err) { handleError(err, 'subscribe(immediate)'); }
      }
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };

  function notify() {
    // Iterate a snapshot so that subscribe/unsubscribe inside a callback does
    // not skip or double-fire subscribers.
    const snapshot = subs.slice();
    for (const entry of snapshot) {
      if (subs.indexOf(entry) < 0) continue;
      let next;
      try {
        next = entry.selector(state);
      } catch (err) {
        handleError(err, 'selector');
        continue;
      }
      if (entry.equals(entry.last, next)) continue;
      entry.last = next;
      try {
        entry.cb(next);
      } catch (err) {
        handleError(err, 'subscriber');
      }
    }
  }

  /**
   * @param {unknown} err
   * @param {string} where
   */
  function handleError(err, where) {
    if (log && typeof log.error === 'function') {
      const msg = err instanceof Error ? err.message : String(err);
      try { log.error(`createStore: ${where} threw: ${msg}`); }
      catch (_) { /* intentional: logging must never throw */ }
    }
  }
}

module.exports = { createStore };