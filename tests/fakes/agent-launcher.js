'use strict';

// Two launchers for the shell, the shape app/agent-launcher.js has: one keeps the fake agent in
// this process (memoryPair), one forks it for real, so the same contract runs over a genuine
// process boundary. `made` / `children` are the test's handle on the current agent.

const path = require('node:path');
const { fork } = require('node:child_process');
const { memoryPair } = require('../../src/main/platform/agent/transport/memory');
const { nodeIpcTransport } = require('../../src/main/platform/agent/transport/node-ipc');
const { fakeAgentOn } = require('./agent-fake');

const ENTRY = path.join(__dirname, 'agent-fake.js');

function memoryLauncher(options = {}) {
  const made = [];
  return {
    made,
    async start() {
      const [host, far] = memoryPair();
      made.push(fakeAgentOn(far, options));
      return { transport: host, kill: () => host.close() };
    },
  };
}

function forkLauncher() {
  const children = [];
  return {
    children,
    async start() {
      const child = fork(ENTRY, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      return { transport: nodeIpcTransport(child), kill: () => child.kill() };
    },
    // control messages are not in the catalog: sent raw, on the same ordered channel
    say(type, payload) {
      const child = children.at(-1);
      if (child?.connected) child.send({ v: 1, kind: 'cmd', type, payload });
    },
  };
}

module.exports = { memoryLauncher, forkLauncher, ENTRY };