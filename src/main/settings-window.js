'use strict';

// Her settings window: an ordinary window, apart from the overlay. One at a time: asking again
// brings the open one forward with the focus. It takes the mouse and the keyboard like any window
// (the overlay's click-through is the overlay's own); closing it leaves her where she is.
// Electron is passed in (BrowserWindow, the app's focus), so the life of the window can be tested.

const WIDTH = 720;
const HEIGHT = 540;
// the ink of her panels (styles/tokens.css), so the window doesn't flash white while it loads
const BACKGROUND = '#17111e';

/**
 * @param {object} deps
 *   BrowserWindow: Electron's
 *   preload: the settings preload (settings-preload.js); url: the settings page
 *   view(): what it shows (settings-view.js), asked when it opens and on update()
 *   area(): the work area to center it in, { x, y, width, height }
 *   focusApp(): brings the app forward first (macOS, where she has no Dock icon)
 *   onClosed(): after the window is gone
 */
function createSettingsWindow({ BrowserWindow, preload, url, view, area, focusApp = () => {}, onClosed = () => {} }) {
  let win = null;
  const alive = () => Boolean(win && !win.isDestroyed());

  function bounds() {
    const a = area?.();
    if (!a) return { width: WIDTH, height: HEIGHT };
    const width = Math.min(WIDTH, a.width);
    const height = Math.min(HEIGHT, a.height);
    return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
  }

  function bringForward() {
    if (win.isMinimized()) win.restore();
    focusApp();
    win.show();
    win.focus();
  }

  function open() {
    if (alive()) {
      bringForward();
      return win;
    }
    win = new BrowserWindow({
      ...bounds(),
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: view().title,
      backgroundColor: BACKGROUND,
      autoHideMenuBar: true,
      fullscreenable: false,
      maximizable: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    const current = win;
    win.removeMenu?.(); // Windows and Linux: no File/Edit bar over it
    // its page stays its page: no other site in it, no popups
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      if (current === win) bringForward();
    });
    win.on('closed', () => {
      if (current !== win) return;
      win = null;
      onClosed();
    });
    win.loadURL(url);
    return win;
  }

  function close() {
    if (alive()) win.close();
  }

  // the config or her language changed: the window shows it as it is now
  function update() {
    if (!alive()) return;
    const v = view();
    win.setTitle(v.title);
    win.webContents.send('settings:view', v);
  }

  return {
    open,
    close,
    update,
    isOpen: alive,
    window: () => (alive() ? win : null),
    // whether an IPC message comes from this window (the overlay can't use its channels)
    owns: (sender) => alive() && sender === win.webContents,
  };
}

module.exports = { createSettingsWindow, WIDTH, HEIGHT };
