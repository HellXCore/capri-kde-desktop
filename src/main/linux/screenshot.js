'use strict';

// A picture of the screen on Linux. Under XWayland (platform_ozone=x11) Electron's desktopCapturer sees only
// the X windows, so a Wayland desktop shows up empty or black. KDE's Spectacle takes it from KWin
// itself, with no prompt. Resolves with a nativeImage, or null where Spectacle is not there or
// fails (the caller falls back to desktopCapturer).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
});

// multi: more than one screen, so only the one the pointer is on (-m); else the whole desktop (-f)
async function grab({ multi = false, exec = run, nativeImage = require('electron').nativeImage } = {}) {
  const file = path.join(os.tmpdir(), `capri-shot-${randomUUID()}.png`);
  try {
  // 1. Spectacle (KDE Plasma) -b background, -n no notification, -o where to save
  await exec('spectacle', ['-b', '-n', multi ? '-m' : '-f', '-o', file]);
  const image = nativeImage.createFromPath(file);
  if (!image.isEmpty()) return image;
} catch {
  try {
    // 2. Gnome-screenshot (GNOME X11/Wayland old version)
    await exec('gnome-screenshot', ['-f', file]);
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  } catch {
    try {
      // 3. Grim (Wayland: Hyprland, Sway, etc)
      await exec('grim', [file]);
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image;
    } catch {
      return null;
    }
  }
} finally {
    fs.rm(file, { force: true }, () => {});
  }
}

module.exports = { grab };
