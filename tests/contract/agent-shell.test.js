'use strict';

// The DesktopShell contract on the agent-backed implementation, both ways the agent is reached:
// in this process over the memory pair, and in a real forked child over node IPC. The frames the
// contract publishes are emitted by the agent itself, so the whole wire is under test — not a
// shortcut into the shell's observables.

const { runShellContract } = require('./shell.contract');
const { createAgentShell } = require('../../src/main/platform/shell/agent-shell');
const { createFakeClock } = require('../fakes/fake-clock');
const { memoryLauncher, forkLauncher, ENTRY } = require('../fakes/agent-launcher');
const { CAPS } = require('../fakes/agent-fake');
const { ENV } = require('../fakes/agent-messages');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

runShellContract('AgentShell + memory agent', (t) => {
  const clock = createFakeClock();
  const launcher = memoryLauncher({ beatMs: 0 }); // beats are the test's to send
  const shell = createAgentShell({ launcher, entry: 'memory', env: ENV, expected: CAPS, clock, log: silent });
  t.after(() => shell.stop());
  const control = (type, payload) => launcher.made.at(-1)?.control(type, payload);
  return {
    shell,
    drive: {
      frame: (f) => control('fake.frame', f),
      stall: () => { control('fake.stall'); return () => control('fake.release'); },
    },
  };
});

runShellContract('AgentShell + forked agent', (t) => {
  const launcher = forkLauncher();
  const shell = createAgentShell({ launcher, entry: ENTRY, env: ENV, expected: CAPS, clock: realClock, log: silent });
  t.after(() => shell.stop());
  return {
    shell,
    drive: {
      frame: (f) => launcher.say('fake.frame', f),
      stall: () => { launcher.say('fake.stall'); return () => launcher.say('fake.release'); },
    },
  };
});