'use strict';

// The two channel shapes the transports are handed, stood in for: the parent port of a utility
// process (a MessagePort) and a forked process's IPC channel. Both deliver a copy on a microtask,
// both can be closed from either end, and both record what was said to them — enough to test the
// plumbing without Electron and without a second process.

const { EventEmitter } = require('node:events');

const copy = (msg) => JSON.parse(JSON.stringify(msg));

function pair(make) {
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// A MessagePort: postMessage out, 'message' in with the value under `data`, 'close' when the other
// end goes away. start() is what a MessagePortMain needs before it flows.
function portPair() {
  return pair(() => {
    const port = new EventEmitter();
    port.sent = [];
    port.started = 0;
    port.closed = 0;
    port.postMessage = (msg) => {
      if (port.closed) throw new Error('the port is closed');
      port.sent.push(msg);
      const peer = port.peer;
      const data = copy(msg);
      queueMicrotask(() => peer.emit('message', { data }));
    };
    port.start = () => { port.started += 1; };
    port.close = () => {
      port.closed += 1;
      const peer = port.peer;
      queueMicrotask(() => peer.emit('close'));
    };
    return port;
  });
}

// child_process IPC: send out (with its callback), 'message' in with the value itself,
// 'disconnect' when the channel is severed, 'exit' when the process goes.
function ipcPair() {
  return pair(() => {
    const proc = new EventEmitter();
    proc.sent = [];
    proc.disconnected = 0;
    proc.send = (msg, cb) => {
      if (proc.disconnected) {
        if (cb) queueMicrotask(() => cb(new Error('channel closed')));
        return false;
      }
      proc.sent.push(msg);
      const peer = proc.peer;
      const value = copy(msg);
      queueMicrotask(() => { peer.emit('message', value); if (cb) cb(null); });
      return true;
    };
    proc.disconnect = () => {
      proc.disconnected += 1;
      const peer = proc.peer;
      queueMicrotask(() => peer.emit('disconnect'));
    };
    return proc;
  });
}

module.exports = { portPair, ipcPair };
