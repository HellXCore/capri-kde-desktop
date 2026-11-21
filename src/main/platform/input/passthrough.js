'use strict';

// The window is seen, never clicked: there is no way to reach it with an input region here (a
// native Wayland window with no compositor-side helper, or no display at all). The ignore flag is
// asserted once, at creation; nothing ever takes it back, so no event sequence can leave the
// overlay intercepting clicks meant for the desktop under it.

/** @typedef {{ x: number, y: number, width: number, height: number }} ZoneRect */

/**
 * @param {{ window?: { setIgnoreMouseEvents: (v: boolean) => void }, setIgnore?: (v: boolean) => void }} o
 */
function createPassthroughInput({ window, setIgnore }) {
  const say = setIgnore || ((v) => window?.setIgnoreMouseEvents(v));
  say(true);
  return {
    kind: /** @type {const} */ ('passthrough'),
    /** @param {ZoneRect[]} _rects @param {number} [_dpr] */
    set(_rects, _dpr) {},
    /** @param {{ x: number, y: number }} _p */
    pointer(_p) {},
    reapply() {},
    state: () => null,
    stats: () => null,
    close() {},
  };
}

module.exports = { createPassthroughInput };