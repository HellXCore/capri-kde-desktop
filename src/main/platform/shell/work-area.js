'use strict';

// The work area as the platform knows it, per display. Chromium cannot see panels on native
// Wayland, so the shell may know the usable area better than Electron does; its answer is asked
// for again when the shell comes up and when the displays change, and kept between refreshes.
// No answer (null) — or a request that failed — means the caller falls back to Electron's own
// work area, exactly as before the port existed.

/** @typedef {import('../../core/ports').DipRect} DipRect */
/** @typedef {import('../../core/ports').DesktopShell} DesktopShell */

/** A rectangle as Electron's screen and BrowserWindow speak it. */
/** @typedef {{ x: number, y: number, width: number, height: number }} ElectronRect */

/** The display facts the area computation reads (Electron's screen reports more; this is enough). */
/** @typedef {{ id: number, bounds: ElectronRect, workArea: ElectronRect }} DisplayFacts */

/** @param {DipRect | null} a @param {DipRect | null} b */
const sameRect = (a, b) => a === b || Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/**
 * Where her window goes on a display, and how far it hangs below the work area's bottom (`gap`).
 * `known` is the platform's work area (the port's answer), or null: then Electron's own is used.
 * Resting on the taskbar: the whole screen less its top row of pixels (a window covering the
 * whole screen reads as fullscreen to the desktop), her legs hanging over the panel. The port
 * speaks {x,y,w,h}; the window speaks Electron's shape — renamed here at the boundary, not
 * recomputed: both are global DIPs.
 * @param {DisplayFacts} display
 * @param {string} rest
 * @param {DipRect | null} known
 * @returns {{ area: ElectronRect, gap: number }}
 */
function overlayAreaFor(display, rest, known) {
  const workArea = known ? { x: known.x, y: known.y, width: known.w, height: known.h } : display.workArea;
  const { bounds } = display;
  const area = rest === 'taskbar' ? { ...bounds, y: bounds.y + 1, height: bounds.height - 1 } : workArea;
  return { area, gap: area.y + area.height - (workArea.y + workArea.height) };
}

/**
 * The port's work areas, kept per display. A failed request reads as no answer, never as a stale
 * area; a refresh overtaken by a newer one is dropped, so the newest answers win.
 * @param {{ shell: DesktopShell }} o
 */
function createWorkArea({ shell }) {
  /** @type {Map<number, DipRect | null>} */
  let areas = new Map();
  let generation = 0;

  return {
    /**
     * Ask about every display. Resolves with whether the effective answers changed — the caller
     * refits her window on true; a first refresh that learns nothing but nulls changes nothing.
     * @param {number[]} displayIds
     * @returns {Promise<boolean>}
     */
    async refresh(displayIds) {
      const gen = ++generation;
      const ids = [...displayIds];
      // a request that fails (the shell stopped, the agent away) is no answer: Electron's own
      const answers = await Promise.all(ids.map((id) => shell.observe.workArea(id).catch(() => null)));
      if (gen !== generation) return false;
      const entries = ids.map((id, i) => /** @type {[number, DipRect | null]} */ ([id, answers[i]]));
      const next = new Map(entries);
      let changed = false;
      for (const id of new Set([...areas.keys(), ...next.keys()])) {
        if (!sameRect(areas.get(id) ?? null, next.get(id) ?? null)) { changed = true; break; }
      }
      areas = next;
      return changed;
    },
    /**
     * The last answer for a display, or null (no answer yet, or the platform knows no better).
     * @param {number} id
     * @returns {DipRect | null}
     */
    get(id) { return areas.get(id) ?? null; },
  };
}

module.exports = { createWorkArea, overlayAreaFor };