'use strict';

// Both ends of the channel in one process, for unit tests. Messages are copied the way a real
// channel would carry them — through JSON — so anything not JSON-compatible fails here exactly
// as it would over the wire, and neither end can reach into the other's objects. Delivery is a
// microtask: ordered per sender, never re-entrant into the caller.

/** @typedef {import('../protocol').Envelope} Envelope */
/** @typedef {import('../protocol').Transport} Transport */

/** @typedef {{ readers: Array<(msg: unknown) => void>, closers: Array<(reason?: string) => void>, closed: boolean }} End */

/** @returns {[Transport, Transport]} */
function memoryPair() {
  /** @returns {End} */
  const end = () => ({ readers: [], closers: [], closed: false });
  const a = end();
  const b = end();

  /** @param {End} e @param {string} reason */
  const finish = (e, reason) => {
    if (e.closed) return;
    e.closed = true;
    for (const fn of e.closers.slice()) fn(reason);
  };

  /** @param {End} self @param {End} other @returns {Transport} */
  const transport = (self, other) => ({
    /** @param {Envelope} msg */
    send(msg) {
      if (self.closed || other.closed) return;
      const copy = JSON.parse(JSON.stringify(msg));
      queueMicrotask(() => {
        if (other.closed) return;
        for (const fn of other.readers.slice()) fn(copy);
      });
    },
    /** @param {(msg: unknown) => void} fn */
    onMessage(fn) { self.readers.push(fn); },
    /** @param {(reason?: string) => void} fn */
    onClose(fn) { self.closers.push(fn); },
    close() {
      finish(self, 'closed');
      finish(other, 'the peer closed');
    },
  });

  return [transport(a, b), transport(b, a)];
}

module.exports = { memoryPair };
