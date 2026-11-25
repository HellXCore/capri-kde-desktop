'use strict';

// The coordinate spaces, converted in one place. A global DIP rect is what Electron's screen
// reports; an X-pixel rect belongs to a backend and never travels; a local rect is measured
// from the overlay's own top left corner, which is what the renderer is given. The shapes are
// declared once, in ports.js — here they are only told apart by name and converted.
//
// The X11 model (Chromium): a display's rect in X pixels is its DIP bounds times its own
// scale. A rect converts by the display holding its centre; a centre no display holds (the
// gap between differently scaled monitors, or off the desktop) converts by the first one.
// Fractions are kept: a caller that needs whole pixels rounds at its own boundary.

/** @typedef {import('./ports').Rect} Rect */
/** @typedef {import('./ports').DipRect} DipRect */
/** @typedef {import('./ports').PxRect} PxRect */
/** @typedef {import('./ports').LocalRect} LocalRect */
/** @typedef {import('./ports').DisplayInfo} DisplayInfo */
/** @typedef {{ x: number, y: number }} Point */

/**
 * A global DIP rect as seen from the overlay's top left corner. Size is untouched.
 * @param {DipRect} r
 * @param {DipRect} overlay
 * @returns {LocalRect}
 */
const toLocal = (r, overlay) => ({ x: r.x - overlay.x, y: r.y - overlay.y, w: r.w, h: r.h });

/**
 * * Whether two rects have a point in common. A rect is the half-open set of points its edges
 * span, so touching edges share nothing, and a rect with no area has no points to share at all
 * — the same reading `contains` uses. Comparing the extents alone would call an empty rect
 * lying inside another an overlap.
 * @param {Rect} a
 * @param {Rect} b
 * @returns {boolean}
 */
const intersects = (a, b) =>
  a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0
  && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Whether a point is inside a rect. Half-open: the left and top edges belong to it, the
 * right and bottom edges do not, so a point on the border of two side-by-side displays
 * belongs to exactly one of them.
 * @param {Rect} r
 * @param {Point} p
 * @returns {boolean}
 */
const contains = (r, p) =>
  p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/** @param {Rect} r @returns {Point} */
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * The index of the rect holding the point, or 0 when none does: the first display converts
 * what lies outside all of them.
 * @param {Rect[]} rects
 * @param {Point} p
 * @returns {number}
 */
const holder = (rects, p) => {
  const i = rects.findIndex((r) => contains(r, p));
  return i < 0 ? 0 : i;
};

/**
 * X pixels to global DIPs, by the display holding the rect's centre. With no displays the
 * numbers pass through untouched. The arithmetic is the legacy watcher's, unchanged: the
 * display's DIP origin plus the rect's offset from the display's pixel origin, unscaled.
 * @param {PxRect} r
 * @param {DisplayInfo[]} displays
 * @returns {DipRect}
 */
function pxToDip(r, displays) {
  if (!displays.length) return { ...r };
  const px = displays.map((d) => {
    const s = d.scale || 1;
    return { x: d.bounds.x * s, y: d.bounds.y * s, w: d.bounds.w * s, h: d.bounds.h * s };
  });
  const i = holder(px, center(r));
  const b = displays[i].bounds;
  const s = displays[i].scale || 1;
  return {
    x: b.x + (r.x - px[i].x) / s,
    y: b.y + (r.y - px[i].y) / s,
    w: r.w / s,
    h: r.h / s,
  };
}

/**
 * Global DIPs to X pixels: the same model read the other way, by the display holding the
 * rect's centre in DIPs. Written as the mirror of pxToDip — the display's pixel origin plus
 * the offset within it, scaled (algebraically x*s: the origin cancels between the two).
 * @param {DipRect} r
 * @param {DisplayInfo[]} displays
 * @returns {PxRect}
 */
function dipToPx(r, displays) {
  if (!displays.length) return { ...r };
  const i = holder(displays.map((d) => d.bounds), center(r));
  const b = displays[i].bounds;
  const s = displays[i].scale || 1;
  return {
    x: b.x * s + (r.x - b.x) * s,
    y: b.y * s + (r.y - b.y) * s,
    w: r.w * s,
    h: r.h * s,
  };
}

module.exports = { toLocal, intersects, contains, pxToDip, dipToPx };