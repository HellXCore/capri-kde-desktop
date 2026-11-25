'use strict';

// The desktop picture as the shell speaks it: WindowsFrame (core/ports.js), in global DIPs,
// with a revision that grows on every change. The adapters hand over snapshots already in
// global DIPs (the conversion is at the backend boundary); the feed turns them into frames
// and splits the rare device reports onto their own channel. The renderer's payload is a
// projection of the last frame, made when it is sent: moving the overlay re-projects the
// same frame, it does not change the desktop.

const { toLocal, intersects } = require('../../core/geometry');

/** @typedef {import('../../core/ports').DipRect} DipRect */
/** @typedef {import('../../core/ports').WindowsFrame} WindowsFrame */
/** @typedef {import('../../core/ports').DevicesFact} DevicesFact */

/**
 * A watcher's snapshot in the legacy shape (x11.buildSnapshot / kwin-bridge.fromPayload),
 * already in global DIPs: the adapter converted it at the backend boundary.
 * @typedef {{
 *   fg: number, taskbar?: boolean, ai?: string[], game?: unknown,
 *   usb?: string[], plug?: { n: number, in: boolean, name: string, class: string } | null,
 *   wins: { id: number, x: number, y: number, w: number, h: number, max: boolean }[],
 * }} LegacySnapshot
 */

/** The overlay's place as Electron and the overlay controller speak it. */
/** @typedef {{ x: number, y: number, width: number, height: number }} OverlayBounds */

/** @param {DipRect | null} a @param {DipRect | null} b */
const sameRect = (a, b) => a === b || Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** @param {string[]} a @param {string[]} b */
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// A plug report is rebuilt on every device poll; its counter and fields say whether it is news.
/** @param {LegacySnapshot['plug']} a @param {LegacySnapshot['plug']} b */
const samePlug = (a, b) => a === b || Boolean(a && b && a.n === b.n && a.in === b.in && a.name === b.name && a.class === b.class);

// Whether two frames describe the same desktop (the revision aside). Field by field, never
// by serialising: this is the change detection the revision is built on.
/** @param {WindowsFrame} a @param {WindowsFrame} b */
function sameFrame(a, b) {
  return a.fg === b.fg && a.dock === b.dock && sameRect(a.self, b.self)
    && a.front.game === b.front.game && sameList(a.front.ai, b.front.ai)
    && a.wins.length === b.wins.length
    && a.wins.every((w, i) => {
      const o = b.wins[i];
      return w.id === o.id && w.max === o.max && sameRect(w.rect, o.rect);
    });
}

/**
 * @param {{
 *   self?: (snap: LegacySnapshot) => DipRect | null,
 *   onFrame: (frame: WindowsFrame) => void,
 *   onFact?: (fact: DevicesFact) => void,
 * }} o
 */
function createFrameFeed({ self = () => null, onFrame, onFact = () => {} }) {
  /** @type {WindowsFrame | null} */
  let frame = null;
  /** @type {{ usb: string[], plug: LegacySnapshot['plug'] }} */
  let devices = { usb: [], plug: null };
  let rev = 0;

  return {
    /** @param {LegacySnapshot} snap */
    push(snap) {
      // Devices first: when both changed, the frame that follows already carries them into
      // the renderer payload, and a first device report never overtakes the first frame.
      const usb = Array.isArray(snap.usb) ? snap.usb : [];
      const plug = snap.plug ?? null;
      if (!sameList(devices.usb, usb) || !samePlug(devices.plug, plug)) {
        devices = { usb, plug };
        onFact({ kind: 'devices', usb, plug });
      }
      /** @type {WindowsFrame} */
      const next = {
        rev: 0,
        fg: snap.fg || 0,
        dock: Boolean(snap.taskbar),
        front: { ai: Array.isArray(snap.ai) ? snap.ai : [], game: snap.game ?? null },
        wins: (snap.wins || []).map((w) => ({ id: w.id, rect: { x: w.x, y: w.y, w: w.w, h: w.h }, max: Boolean(w.max) })),
        self: self(snap) || null,
      };
      if (frame && sameFrame(frame, next)) return;
      next.rev = ++rev;
      frame = next;
      onFrame(frame);
    },
    // The same picture again (the overlay moved): the same revision, consumers re-project.
    resend() { if (frame) onFrame(frame); },
    /** @returns {WindowsFrame | null} */
    last() { return frame; },
  };
}

/**
 * The renderer's windows:update payload — the legacy format, unchanged: local coordinates
 * (from the overlay's top left), only what overlaps its screen, the devices merged in, and
 * the confirmed place as `self`. The one place toLocal is applied for the renderer.
 * @param {WindowsFrame} frame
 * @param {OverlayBounds} overlayBounds
 * @param {{ usb: string[], plug: object | null }} [devices]
 */
function toRendererPayload(frame, overlayBounds, devices = { usb: [], plug: null }) {
  const origin = { x: overlayBounds.x, y: overlayBounds.y, w: 0, h: 0 };
  const viewport = { x: 0, y: 0, w: overlayBounds.width, h: overlayBounds.height };
  const wins = [];
  for (const win of frame.wins) {
    const local = toLocal(win.rect, origin);
    if (!intersects(local, viewport)) continue;
    wins.push({ id: win.id, x: local.x, y: local.y, w: local.w, h: local.h, max: win.max });
  }
  return {
    fg: frame.fg, taskbar: frame.dock, ai: frame.front.ai, game: frame.front.game,
    usb: devices.usb, plug: devices.plug, wins, self: frame.self,
  };
}

module.exports = { createFrameFeed, toRendererPayload };