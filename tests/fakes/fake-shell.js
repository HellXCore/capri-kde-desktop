'use strict';

// A DesktopShell the test drives by hand. It publishes what it is told (frames, pointer, facts,
// hotkeys, health), answers requests with plain defaults, and writes every call it receives into
// a journal. Nothing here talks to a desktop; the contract suite (tests/contract/shell.contract.js)
// keeps it honest about the port's mechanics, and the checks next to it about its own controls.

const stoppedError = () => Object.assign(new Error('the shell is stopped'), { code: 'stopped' });

// Subscribers hear values synchronously, in subscription order, over a snapshot of the list (an
// unsubscribe inside a callback must not skip the next one). last() replays the newest value so a
// late subscriber can catch up; subscribing itself never replays.
function observable() {
  const subs = new Set();
  let last;
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    last: () => last,
    publish(value) {
      last = value;
      for (const fn of [...subs]) fn(value);
    },
    clear() { subs.clear(); },
  };
}

// A tier-1 compositor backend, the richest shape the port allows; tests bend it with setCaps.
const DEFAULT_CAPS = {
  tier: 1, backend: 'kwin', windows: true, pointer: true,
  apps: { list: true, close: true }, hotkey: true,
  screenshot: ['spectacle', 'portal'],
  overlay: { place: 'compositor', stacking: 'compositor', focus: 'compositor', input: 'toggle' },
};

/**
 * @returns {{ shell: import('../../src/main/core/ports').DesktopShell,
 *   drive: { frame: (f: import('../../src/main/core/ports').WindowsFrame) => void, stall: () => () => void },
 *   journal: Array<{ op: string, args: unknown[] }>,
 *   emitFrame: (f: import('../../src/main/core/ports').WindowsFrame) => void,
 *   emitPointer: (p: { x: number, y: number }) => void,
 *   emitFact: (f: import('../../src/main/core/ports').DevicesFact) => void,
 *   emitHotkey: (id: string) => void,
 *   setCaps: (patch?: object) => void,
 *   setHealth: (state: import('../../src/main/core/ports').AgentState, reason?: string) => void }}
 */
function createFakeShell() {
  let caps = structuredClone(DEFAULT_CAPS);
  let state = 'idle';
  let stalled = false;
  const pending = new Set(); // requests held by drive.stall(); release() or stop() settles them
  const journal = [];        // every call received, in order: { op, args }

  const health = observable();
  const frames = observable();
  const pointer = observable();
  const facts = observable();
  const onHotkey = observable();
  health.publish({ state: 'idle' });

  // A request method: journals the call, never throws synchronously, rejects with code 'stopped'
  // once stopped, parks while stalled, otherwise resolves with produce(...args).
  const request = (op, produce) => (...args) => {
    journal.push({ op, args });
    if (state === 'stopped') return Promise.reject(stoppedError());
    return new Promise((resolve, reject) => {
      const settle = { resolve: () => resolve(produce(...args)), reject };
      if (stalled) pending.add(settle);
      else settle.resolve();
    });
  };
  // A void command: only the journal; the fake has no desktop to act on.
  const command = (op) => (...args) => { journal.push({ op, args }); };

  const shell = {
    caps: () => structuredClone(caps),
    health,
    observe: { frames, pointer, facts, workArea: request('observe.workArea', () => null) },
    overlay: {
      request: request('overlay.request', (r) => r), // the confirmed rect is the requested one
      raise: command('overlay.raise'),
      focus: command('overlay.focus'),
      zones: command('overlay.zones'),
      identity: command('overlay.identity'),
    },
    control: {
      hotkey: request('control.hotkey', () => true),
      onHotkey,
      closeApps: request('control.closeApps', () => ({ running: false })),
    },
    os: {
      windows: request('os.windows', () => []),
      launchables: request('os.launchables', () => []),
      launch: request('os.launch', () => undefined),
      media: request('os.media', () => true),
      search: request('os.search', () => []),
      screenshot: request('os.screenshot', () => null),
      terminal: request('os.terminal', () => true),
    },
    setDisplays: command('setDisplays'),
    async start() {
      if (state === 'ready') return;
      state = 'ready';
      health.publish({ state: 'ready' });
    },
    async stop() {
      if (state === 'stopped') return;
      state = 'stopped';
      health.publish({ state: 'stopped' }); // heard before the subscribers go
      for (const s of pending) s.reject(stoppedError());
      pending.clear();
      for (const obs of [health, frames, pointer, facts, onHotkey]) obs.clear();
    },
  };

  const emitFrame = (f) => frames.publish(f);
  const emitPointer = (p) => pointer.publish(p);
  const emitFact = (f) => facts.publish(f);
  const emitHotkey = (id) => onHotkey.publish(id);

  // Cells are merged, not replaced wholesale: a patch naming one overlay cell keeps the others,
  // so caps() always stays the full closed shape the port declares.
  const setCaps = (patch = {}) => {
    caps = {
      ...caps,
      ...patch,
      apps: { ...caps.apps, ...(patch.apps || {}) },
      overlay: { ...caps.overlay, ...(patch.overlay || {}) },
    };
  };

  // Publishes on the health channel only; the lifecycle (what start/stop and requests do) is not
  // touched, so a test can show 'degraded' while the shell still answers.
  const setHealth = (next, reason) => health.publish(reason === undefined ? { state: next } : { state: next, reason });

  return {
    shell,
    // the contract suite's vocabulary
    drive: {
      frame: emitFrame,
      stall() {
        stalled = true;
        return () => {
          stalled = false;
          for (const s of pending) s.resolve();
          pending.clear();
        };
      },
    },
    journal,
    emitFrame, emitPointer, emitFact, emitHotkey,
    setCaps, setHealth,
  };
}

module.exports = { createFakeShell };