'use strict';

// A BrowserWindow the controller can own without Electron: every call is recorded in order, the
// bounds are kept as they were set, and events are emitted by the test. Nothing here draws or
// takes input; what the controller told the window is the whole truth of it.

const { EventEmitter } = require('node:events');

function createFakeWindow(options = {}) {
  const calls = [];
  const win = new EventEmitter();
  let bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
  let destroyed = false;
  const rec = (op, ...args) => calls.push({ op, args });

  Object.assign(win, {
    options,
    calls,
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; win.emit('closed'); },
    getBounds: () => ({ ...bounds }),
    setBounds: (r) => { rec('setBounds', r); bounds = { x: r.x, y: r.y, width: r.width, height: r.height }; },
    setIgnoreMouseEvents: (v, o) => rec('setIgnoreMouseEvents', v, o),
    setShape: (r) => rec('setShape', r),
    setAlwaysOnTop: (v, level) => rec('setAlwaysOnTop', v, level),
    moveTop: () => rec('moveTop'),
    setFocusable: (v) => rec('setFocusable', v),
    focus: () => rec('focus'),
    blur: () => rec('blur'),
    showInactive: () => rec('showInactive'),
    loadURL: (url) => rec('loadURL', url),
    webContents: Object.assign(new EventEmitter(), {
      send: (ch, p) => rec('send', ch, p),
      invalidate: () => rec('invalidate'),
      openDevTools: (o) => rec('openDevTools', o),
      isDestroyed: () => destroyed,
    }),
  });

  return {
    win,
    calls,
    last: (op) => [...calls].reverse().find((c) => c.op === op) || null,
    count: (op) => calls.filter((c) => c.op === op).length,
    emit: (e, ...a) => win.emit(e, ...a),
  };
}

module.exports = { createFakeWindow };