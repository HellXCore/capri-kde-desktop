'use strict';

// macOS window-watch probe (CAPRI-08 prototype), inside Electron:
//   npx electron scripts/mac-window-probe.js [seconds]      (build the helper first, see docs)
// Opens a transparent click-through window over the main display, like Capri's overlay but on the
// normal window level so that only the helper's --self-window filter keeps it out, and prints
// Electron's displays next to the helper's, then the overlay updates for a few seconds (window
// ids and rectangles only). Move, minimize or full-screen some windows meanwhile to watch them.

const { app, BrowserWindow, screen } = require('electron');
const { execFileSync } = require('node:child_process');
const { startMacWindowWatch, overlayWindowId, parseLine, HELPER } = require('../src/main/mac/window-watch');

const seconds = Number(process.argv.find((a) => /^\d+$/.test(a))) || 10;

app.whenReady().then(() => {
  app.dock?.hide();
  const { bounds } = screen.getPrimaryDisplay();
  const overlay = new BrowserWindow({
    ...bounds, transparent: true, backgroundColor: '#00000000', frame: false, resizable: false,
    movable: false, focusable: false, hasShadow: false, skipTaskbar: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('data:text/html,<body style="background:transparent"></body>');
  overlay.once('ready-to-show', () => {
    overlay.showInactive();
    setTimeout(() => run(overlay), 500);
  });
});

function run(overlay) {
  const self = overlayWindowId(overlay);
  const raw = parseLine(execFileSync(HELPER, ['--once']).toString());
  console.log('electron displays:', screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor })));
  console.log('helper displays:  ', raw.displays);
  console.log(`overlay window id ${self}; unfiltered helper ${raw.wins.some((w) => w.id === self) ? 'lists it' : 'does not list it'}`);

  let updates = 0;
  let leaked = false;
  const watch = startMacWindowWatch({
    overlay,
    onUpdate: (u) => {
      updates++;
      if (u.wins.some((w) => w.id === self)) leaked = true;
      const front = u.wins.find((w) => w.id === u.fg);
      console.log(`update ${updates}: fg=${u.fg} ${u.wins.length} windows`
        + (front ? `, front at ${front.x},${front.y} ${front.w}x${front.h}${front.max ? ' max' : ''}${front.full ? ' full' : ''}` : ''));
    },
  });
  setTimeout(() => {
    watch.stop();
    console.log(`${updates} updates; overlay ${leaked ? 'LEAKED into' : 'kept out of'} the windows`);
    app.exit(leaked || !updates ? 1 : 0);
  }, seconds * 1000);
}
