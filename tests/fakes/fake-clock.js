'use strict';

// A clock moved by hand. advance(ms) walks time forward and fires every timer that comes due on
// the way, each at its own deadline and in deadline order; ties fire in the order they were
// scheduled. A callback may schedule more timers: ones due inside the same advance still fire,
// ones past its end wait for the next one. Nothing fires while time stands still.

function createFakeClock(start = 0) {
  let now = start;
  let nextId = 0;
  const timers = new Map(); // id -> { at, fn }; insertion order breaks deadline ties

  return {
    now: () => now,

    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },

    clearTimeout(id) {
      timers.delete(id);
    },

    get pending() {
      return timers.size;
    },

    advance(ms) {
      if (!(ms >= 0)) throw new RangeError('advance needs a non-negative span');
      const end = now + ms;
      for (;;) {
        let due = null;
        let dueId = 0;
        for (const [id, t] of timers) {
          if (t.at <= end && (due === null || t.at < due.at)) {
            due = t;
            dueId = id;
          }
        }
        if (due === null) break;
        timers.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

module.exports = { createFakeClock };