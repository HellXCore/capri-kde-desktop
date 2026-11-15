'use strict';

// Your screen locked or the computer asleep (CAPRI-07): main.js tells her overlay, which stops its
// decorative work (renderer pause.js) and starts it again when you're back. Main itself goes on:
// Claude Code's events still come in through bridge.js and are passed on, her reminders still come
// due. See docs/POWER_EVENTS.md for which of Electron's powerMonitor events come on which system.
//
// Away = asleep (suspend .. resume) or locked (lock-screen .. unlock-screen). Each is followed on
// its own: woken with the screen still locked, she stays paused until it's unlocked.
//
// Electron has no lock events on Linux: main.js emits lock-screen/unlock-screen from the session
// bus (org.freedesktop.ScreenSaver ActiveChanged). That signal can be missed (the bus or the
// screensaver restarted), so while she thinks the screen is locked she asks isLocked() now and
// then, and at each wake: false means the unlock was missed.

const EVENTS = {
  suspend: ['asleep', true],
  resume: ['asleep', false],
  'lock-screen': ['locked', true],
  'unlock-screen': ['locked', false],
};
const RECHECK_MS = 30 * 1000;

// power: Electron's powerMonitor (or a stand-in), onChange({ away, why }) when away changes,
// later: timers (the tests' own), log: where the changes are written
function watchPower({
  power, onChange = () => {}, recheckMs = RECHECK_MS, isLocked = null,
  later = { every: setInterval, stop: clearInterval }, log = (line) => console.log(line),
}) {
  const flags = { asleep: false, locked: false, test: false };
  let away = false;
  let recheck = null;
  let stopped = false;
  const lockAware = typeof isLocked === 'function'; // main.js asks the screensaver over D-Bus
  const state = () => ({ away, why: Object.keys(flags).filter((k) => flags[k]) });
  const update = (source) => {
    const now = flags.asleep || flags.locked || flags.test;
    // only while it thinks the screen is locked: a missed unlock is caught, nothing polls otherwise
    if (lockAware && flags.locked && !recheck) recheck = later.every(() => check('recheck'), recheckMs);
    if ((!lockAware || !flags.locked) && recheck) {
      later.stop(recheck);
      recheck = null;
    }
    if (now === away) return;
    away = now;
    log(`[capri] ${away ? 'away' : 'back'} (${source}${away ? `: ${state().why.join(', ')}` : ''})`);
    onChange(state());
  };
  // the screen said locked, and it isn't any more: the unlock event was missed
  const check = async (source) => {
    if (!flags.locked || flags.asleep) return;
    const locked = await isLocked().catch(() => null);
    if (locked !== false || !flags.locked || flags.asleep) return; // it changed while we asked
    flags.locked = false;
    update(`${source}: not locked any more`);
  };

  const handle = (event) => {
    const [flag, on] = EVENTS[event] || [];
    if (!flag) return;
    flags[flag] = on;
    // unlocked or back from another user: you're at it, so the computer is awake, even if its
    // resume never came (Modern Standby can drop it): a lost resume mustn't freeze her for good
    if (event === 'unlock-screen') flags.asleep = false;
    update(event);
    if (event === 'resume' && lockAware) check('resume');
  };
  const listeners = Object.keys(EVENTS).map((event) => [event, () => handle(event)]);
  for (const [event, fn] of listeners) power?.on(event, fn);

  // started with the screen already locked (a login item starting behind the lock screen)
  if (lockAware) {
    isLocked().then((locked) => {
      if (!stopped && locked === true) { flags.locked = true; update('start'); }
    }).catch(() => {});
  }

  return {
    get away() {
      return away;
    },
    state,
    // --dev (debug route `power`): an event as if powerMonitor had sent it, for this watcher only
    // (the lock recheck may undo a pretend lock-screen within RECHECK_MS: the screen isn't locked)
    emit: handle,
    // --dev: away (true) or back (false) on its own, whatever the screen: for measuring her paused
    test(on) {
      flags.test = Boolean(on);
      update(on ? 'test' : 'test over');
    },
    stop() {
      stopped = true;
      for (const [event, fn] of listeners) power?.removeListener(event, fn);
      if (recheck) later.stop(recheck);
      recheck = null;
    },
  };
}

module.exports = { watchPower, EVENTS, RECHECK_MS };
