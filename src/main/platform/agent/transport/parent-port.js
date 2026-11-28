'use strict';

// The agent's end of the utilityProcess channel: process.parentPort, a MessagePort-like object.
// A thin pipe — it carries envelopes out and hands raw values in; what they mean is the codec's
// business. The port's spelling of the message event has varied across versions ({ data } wrapper
// or the value itself), so both are accepted on the way in.

/** @typedef {import('../protocol').Envelope} Envelope */
/** @typedef {import('../protocol').Transport} Transport */

/** @typedef {{ postMessage(msg: unknown): void, on(event: string, fn: (...a: any[]) => void): unknown, removeListener?(event: string, fn: (...a: any[]) => void): unknown, start?(): void, close?(): void }} ParentPort */

/**
 * @param {ParentPort} port
 * @returns {Transport}
 */
function parentPortTransport(port) {
  if (!port || typeof port.postMessage !== 'function' || typeof port.on !== 'function') {
    throw new TypeError('parentPortTransport: a MessagePort-like object is required');
  }
  /** @type {Array<(msg: unknown) => void>} */
  const readers = [];
  /** @type {Array<(reason?: string) => void>} */
  const closers = [];
  let closed = false;

  /** @param {string} reason */
  const finish = (reason) => {
    if (closed) return;
    closed = true;
    for (const fn of closers.slice()) fn(reason);
  };

  /** @param {any} event */
  const onMessage = (event) => {
    const msg = event && typeof event === 'object' && 'data' in event ? event.data : event;
    for (const fn of readers.slice()) fn(msg);
  };
  const onPortClose = () => finish('the parent port closed');

  port.on('message', onMessage);
  port.on('close', onPortClose);
  port.start?.(); // a MessagePortMain only flows once started; the utility parentPort already does

  return {
    /** @param {Envelope} msg */
    send(msg) {
      if (closed) return;
      try {
        port.postMessage(msg);
      } catch (err) {
        finish(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    /** @param {(msg: unknown) => void} fn */
    onMessage(fn) { readers.push(fn); },
    /** @param {(reason?: string) => void} fn */
    onClose(fn) { closers.push(fn); },
    close() {
      if (closed) return;
      port.removeListener?.('message', onMessage);
      port.removeListener?.('close', onPortClose);
      try { port.close?.(); } catch { /* intentional: the port may already be gone */ }
      finish('closed');
    },
  };
}

module.exports = { parentPortTransport };
