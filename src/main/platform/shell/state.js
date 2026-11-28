'use strict';

// What the host wants the platform agent to be doing: the displays it should know, which window is
// the overlay and where it should sit, its interactive zones, who holds the keyboard, the hotkeys it
// owns. Every setter records the wish; the shell sends the command when the agent is live, and the
// whole set is replayed on every `ready`. That is what makes a restart idempotent: an agent that
// died and came back is told the same things again, and no caller has to know it restarted.
//
// Pure data and a send callback — no transport, no clock, no Electron. The replay order is the order
// the agent needs them in: what it is looking at, then geometry, then input, then shortcuts.

/** @typedef {import('../../core/ports').Rect} Rect */
/** @typedef {import('../../core/ports').DipRect} DipRect */
/** @typedef {import('../../core/ports').DisplayInfo} DisplayInfo */
/** @typedef {import('../../core/env').EnvFacts} EnvFacts */
/** @typedef {(type: string, payload: Record<string, unknown>) => void} Send */

/**
 * @param {{ env: EnvFacts }} o
 */
function createDesiredState({ env }) {
  /** @type {{
   *   displays: DisplayInfo[],
   *   overlay: { pid: number, title: string, xid: number|null },
   *   want: DipRect|null,
   *   zones: { rects: Rect[], dpr: number }|null,
   *   focus: boolean,
   *   hotkeys: Map<string, string>,
   * }} */
  const wish = {
    displays: [],
    // hello must name the overlay; until the host says otherwise there is nothing to name
    overlay: { pid: 0, title: '', xid: null },
    want: null,
    zones: null,
    focus: false,
    hotkeys: new Map(),
  };

  return {
    /** @param {DisplayInfo[]} list */
    setDisplays(list) { wish.displays = list.map((d) => ({ ...d })); },

    // The catalog carries the identity in hello, so a change is applied at the next handshake.
    /** @param {{ pid: number, title: string, xid: number|null }} i */
    setIdentity(i) { wish.overlay = { pid: i.pid, title: i.title, xid: i.xid ?? null }; },

    /** @param {DipRect} r */
    setWant(r) { wish.want = { ...r }; },

    /** @param {{ rects: Rect[], dpr: number }} z */
    setZones(z) { wish.zones = { rects: z.rects.map((r) => ({ ...r })), dpr: z.dpr }; },

    /** @param {boolean} on */
    setFocus(on) { wish.focus = Boolean(on); },

    /** @param {string} id @param {string} accel */
    setHotkey(id, accel) { wish.hotkeys.set(id, accel); },

    // Opens the conversation: the facts the agent selects its backend from, and who we are.
    /** @param {Send} send */
    hello(send) { send('hello', { env, displays: wish.displays, overlay: wish.overlay }); },

    // Everything asked for since the process started, said again. hello already carries the
    // displays; the command is replayed too, so a backend that applies them lazily hears it.
    /** @param {Send} send */
    replay(send) {
      if (wish.displays.length) send('displays', { list: wish.displays });
      if (wish.want) send('overlay.want', { rect: wish.want });
      if (wish.zones) send('overlay.zones', { rects: wish.zones.rects, dpr: wish.zones.dpr });
      send('overlay.focus', { on: wish.focus });
      for (const [id, accel] of wish.hotkeys) send('hotkey.set', { id, accel });
    },
  };
}

module.exports = { createDesiredState };