'use strict';

// The fork channel, both ends: the host hands in the ChildProcess it forked, the agent hands in
// its own process. Same pipe as the parent port, over node:child_process IPC — this is what the
// contract tests and scripts run on, so the protocol is exercised over a real process boundary
// without Electron.

/** @typedef {import('../protocol').Envelope} Envelope */
/** @typedef {import('../protocol').Transport} Transport */

/** @typedef {{ send(msg: unknown, cb?: (err: Error | null) => void): boolean, on(event: string, fn: (...a: any[]) => void): unknown, removeListener?(event: string, fn: (...a: any[]) => void): unknown, disconnect?(): void }} IpcProcess */

/**
 * @param {IpcProcess} proc
 * @returns {Transport}
 */
function nodeIpcTransport(proc) {
  if (!proc || typeof proc.send !== 'function' || typeof proc.on !== 'function') {
    throw new TypeError('nodeIpcTransport: a process with an IPC channel is required');
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

  /** @param {unknown} msg */
  const onMessage = (msg) => { for (const fn of readers.slice()) fn(msg); };
  /** @param {number | null} code @param {string | null} signal */
  const onExit = (code, signal) => finish(`exit ${code ?? signal ?? '?'}`);
  const onDisconnect = () => finish('the IPC channel disconnected');

  proc.on('message', onMessage);
  proc.on('exit', onExit);
  proc.on('disconnect', onDisconnect);

  return {
    /** @param {Envelope} msg */
    send(msg) {
      if (closed) return;
      try {
        proc.send(msg, (err) => { if (err) finish(`send failed: ${err.message}`); });
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
      proc.removeListener?.('message', onMessage);
      proc.removeListener?.('exit', onExit);
      proc.removeListener?.('disconnect', onDisconnect);
      try { proc.disconnect?.(); } catch { /* intentional: the channel may already be severed */ }
      finish('closed');
    },
  };
}

module.exports = { nodeIpcTransport };
