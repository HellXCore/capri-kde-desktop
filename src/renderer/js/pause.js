// Your screen locked or your computer asleep (main.js tells her through host.onPower, CAPRI-07):
// nobody is there to watch, so her decorative work stops. Her drawing loops (capri.js, chip.js,
// fx.js), her panel's text animations and her optional polling (the pointer, the processor, a look
// at your screen, her idle lines) stop, without touching where she is or what she's doing. Claude
// Code's events and her reminders are still counted while she's paused (main.js isn't paused): what
// matters is shown once you're back, through Panel.say() as always. No DOM in here, so it can be
// tested with a clock and timers of its own.

export class Pause {
  // now: the clock the loops use (ms); timers: where setInterval / clearInterval come from, read at
  // each call (the tests swap them)
  constructor({ now = () => performance.now(), timers = globalThis } = {}) {
    this.now = now;
    this.timers = timers;
    this.parts = new Set(); // { pause(), resume(gap) }
    this._paused = false;
    this.since = 0;
  }

  get paused() {
    return this._paused;
  }

  // Away (true) or back (false). Said twice, the second time is nothing. True if it changed.
  set(away) {
    const on = Boolean(away);
    if (on === this._paused) return false;
    this._paused = on;
    if (on) {
      this.since = this.now();
      for (const part of [...this.parts]) part.pause?.();
    } else {
      // how long she was paused: the loops push their own clocks on by it, so nothing jumps
      const gap = Math.max(0, this.now() - this.since);
      for (const part of [...this.parts]) part.resume?.(gap);
    }
    return true;
  }

  // Something to stop and start again with her: { pause(), resume(gap) }. Returns what removes it.
  on(part) {
    this.parts.add(part);
    return () => this.parts.delete(part);
  }

  // Like setInterval(fn, ms), but not while she's paused: the timer is cleared then, and one
  // timer is set again when she's back (never two). Returns { stop() }.
  every(fn, ms) {
    let id = null;
    const start = () => {
      if (id === null) id = this.timers.setInterval(fn, ms);
    };
    const clear = () => {
      if (id !== null) this.timers.clearInterval(id);
      id = null;
    };
    const off = this.on({ pause: clear, resume: start });
    if (!this._paused) start();
    return {
      stop() {
        off();
        clear();
      },
      get running() {
        return id !== null;
      },
    };
  }
}

// The message to keep for when you're back, of the one kept so far and a new one: Panel.say()'s
// priorities, the newer one on a tie (as on screen, where the newer one replaces the older). Only
// what matters is kept (priority >= KEEP): her optional lines and progress lines are dropped, so
// they don't all come at once when you're back.
export const KEEP = 3;
export function keepFor(kept, msg, priority) {
  const p = priority[msg?.kind] ?? 0;
  if (p < KEEP) return kept;
  if (kept && (priority[kept.kind] ?? 0) > p) return kept;
  return msg;
}

// one for the whole overlay
export const pause = new Pause();
