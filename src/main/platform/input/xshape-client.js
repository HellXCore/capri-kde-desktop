'use strict';

// The window's shape is set client-side to the interactive zones. On X11/XWayland the exact input
// shape (XShape ShapeInput, through the injected factory) leaves the drawing untouched; without
// koffi/libXext, or where Electron's own shape is what was asked for, the bounding shape is set
// instead (it clips what is drawn as well). An empty set of zones is a rectangle outside the
// window: setShape([]) would mean the whole window.

/** @typedef {{ x: number, y: number, width: number, height: number }} ZoneRect */
/** @typedef {{ set: (rects: ZoneRect[], dpr?: number) => void, reapply: () => void, close: () => void }} ShapeRegion */

const OFFSCREEN = [{ x: -100, y: -100, width: 1, height: 1 }]; // "nowhere": setShape([]) would be the whole window

/**
 * @param {{ window: { isDestroyed: () => boolean, setShape: (r: ZoneRect[]) => void },
 *           xshape?: ((win: any) => ShapeRegion | null) | null,
 *           mode?: 'xshape' | 'bounding' | 'shape' }} o
 */
function createXShapeInput({ window, xshape = null, mode = 'xshape' }) {
  const region = mode === 'xshape' && xshape ? xshape(window) : null;
  if (region) {
    return {
      kind: /** @type {const} */ ('xshape'),
      /** @param {ZoneRect[]} rects @param {number} [dpr] */
      set: (rects, dpr) => region.set(rects, dpr),
      /** @param {{ x: number, y: number }} _p */
      pointer(_p) {},
      reapply: () => region.reapply(),
      state: () => null,
      stats: () => null,
      close: () => region.close(),
    };
  }
  // Electron's own shape, with whole pixels; nothing at all becomes a rectangle outside the window
  return {
    kind: mode === 'shape' ? /** @type {const} */ ('shape') : /** @type {const} */ ('bounding'),
    /** @param {ZoneRect[]} rects */
    set(rects) {
      const valid = (Array.isArray(rects) ? rects : [])
        .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }))
        .filter((r) => r.width > 0 && r.height > 0);
      if (!window.isDestroyed()) window.setShape(valid.length ? valid : OFFSCREEN);
    },
    /** @param {{ x: number, y: number }} _p */
    pointer(_p) {},
    reapply() {},
    state: () => null,
    stats: () => null,
    close() {},
  };
}

module.exports = { createXShapeInput, OFFSCREEN };