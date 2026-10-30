'use strict';

// Input region for the overlay on X11 / XWayland (src/main/x11-input.js).
//
// Electron's win.setShape() sets the *bounding* shape: it clips what is drawn as well as what gets
// input. Here only the *input* shape is set (XShape kind ShapeInput), so the window is always drawn
// in full (fx, splash, ticker...) and only the given rectangles receive the pointer. Everything
// else is click-through. XWayland passes the X input shape on to the compositor (KWin) as the
// surface's input region.
//
// The backend is isolated behind createInputRegion(win) -> { set, reapply, close } | null, so that
// a native Wayland backend can be added later with the same interface. null: not available here
// (not Linux, no koffi, no libX11/libXext): the caller falls back to its old behaviour.

const SHAPE_INPUT = 2;     // ShapeInput
const SHAPE_SET = 0;       // ShapeSet
const UNSORTED = 0;

let api; // undefined: not tried yet; false: not available; object: loaded

function load() {
  if (api !== undefined) return api;
  api = false;
  if (process.platform !== 'linux') return api;
  try {
    const koffi = require('koffi');
    const x11 = koffi.load('libX11.so.6');
    const xext = koffi.load('libXext.so.6');
    koffi.struct('XRectangle', { x: 'int16', y: 'int16', width: 'uint16', height: 'uint16' });
    const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
    const XCloseDisplay = x11.func('int XCloseDisplay(void *display)');
    const XFlush = x11.func('int XFlush(void *display)');
    const XShapeQueryExtension = xext.func('int XShapeQueryExtension(void *display, _Out_ int *eventBase, _Out_ int *errorBase)');
    const XShapeCombineRectangles = xext.func(
      'void XShapeCombineRectangles(void *display, unsigned long window, int kind, int xOff, int yOff, ' +
      'const XRectangle *rects, int count, int op, int ordering)',
    );
    const display = XOpenDisplay(null);
    if (!display) throw new Error('XOpenDisplay failed (no DISPLAY?)');
    if (!XShapeQueryExtension(display, [0], [0])) throw new Error('no SHAPE extension');
    api = { XCloseDisplay, XFlush, XShapeCombineRectangles, display };
  } catch (err) {
    console.warn('[capri] X11 input shape unavailable:', err?.message ?? err);
    api = false;
  }
  return api;
}

// CSS px rectangles -> window pixels (what X works in), clipped to the window, empties dropped.
function toDevice(rects, dpr, width, height) {
  const out = [];
  for (const r of rects || []) {
    const x0 = Math.max(0, Math.floor(r.x * dpr));
    const y0 = Math.max(0, Math.floor(r.y * dpr));
    const x1 = Math.min(width, Math.ceil((r.x + r.width) * dpr));
    const y1 = Math.min(height, Math.ceil((r.y + r.height) * dpr));
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}

function createInputRegion(win) {
  const x = load();
  if (!x) return null;
  let last = { rects: [], dpr: 1 };

  const apply = () => {
    if (win.isDestroyed()) return;
    const xid = win.getNativeWindowHandle().readUInt32LE(0); // an X Window id fits in 32 bits
    const { width, height } = win.getBounds(); // DIP; the window's pixels are DIP * dpr
    const dpr = last.dpr || 1;
    const rects = toDevice(last.rects, dpr, Math.round(width * dpr), Math.round(height * dpr));
    // no rectangles: an empty input region, the whole window is click-through
    x.XShapeCombineRectangles(x.display, xid, SHAPE_INPUT, 0, 0, rects.length ? rects : null, rects.length, SHAPE_SET, UNSORTED);
    x.XFlush(x.display);
  };

  return {
    // rects: CSS px in the window; dpr: the renderer's window.devicePixelRatio
    set(rects, dpr = 1) {
      last = { rects: Array.isArray(rects) ? rects : [], dpr: Number(dpr) || 1 };
      apply();
    },
    // after the window was resized, moved to another screen or (re)mapped: the server may have dropped it
    reapply: apply,
    close() {
      // the display connection is shared by every overlay; closed with the process
    },
  };
}

module.exports = { createInputRegion };
