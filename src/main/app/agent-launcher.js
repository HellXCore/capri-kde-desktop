'use strict';

// The one place the platform agent's process is created (R2: utilityProcess is Electron's API).
// The shell only sees a Transport and a kill switch, so the same shell runs against a forked child
// in tests (tests/fakes/agent-launcher.js) and against a utility process here — ADR-011: the entry
// stays inside app.asar, no fork fallback in prod.
//
// Electron's UtilityProcess is a child process with a different spelling: postMessage instead of
// send, and the message event has carried either the value or a { data } wrapper across versions.
// Both are accepted on the way in; 'exit' is what severing the channel looks like from here.

const { utilityProcess } = require('electron');
const { nodeIpcTransport } = require('../platform/agent/transport/node-ipc');

const unwrap = (m) => (m && typeof m === 'object' && 'data' in m ? m.data : m);

function createUtilityLauncher({ fork = null, env = process.env } = {}) {
  const spawn = fork || ((entry, options) => utilityProcess.fork(entry, [], options));
  return {
    async start(entry) {
      const childEnv = { ...env };
      delete childEnv.ELECTRON_RUN_AS_NODE; // a utility process is not a plain Node child
      const child = spawn(entry, { env: childEnv, stdio: 'pipe' });
      // the agent speaks through the protocol, not stdout: drain the pipes so a stray write
      // cannot fill them and block it
      child.stdout?.resume?.();
      child.stderr?.resume?.();
      const transport = nodeIpcTransport({
        send(msg, cb) { child.postMessage(msg); if (cb) cb(null); },
        on(event, fn) { child.on(event, event === 'message' ? (m) => fn(unwrap(m)) : fn); },
        disconnect() { child.kill(); },
      });
      return { transport, kill: () => { child.kill(); } };
    },
  };
}

module.exports = { createUtilityLauncher };