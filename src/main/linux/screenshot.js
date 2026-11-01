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

// Inline-script for xdg-desktop-portal throw D-Bus (Gio/GLib)
const PORTAL_SCREENSHOT_SCRIPT = `
import sys, shutil
from urllib.parse import urlparse, unquote
from gi.repository import GLib, Gio

dest = sys.argv[1]
loop = GLib.MainLoop()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
success = False

def on_response(conn, sender, path, iface, signal, params):
    global success
    try:
        res_code, results = params.unpack()
        if res_code == 0 and "uri" in results:
            src = unquote(urlparse(results["uri"]).path)
            shutil.copyfile(src, dest)
            success = True
    except Exception:
        pass
    loop.quit()

# Формируем токен и путь к объекту Request согласно спецификации XDG Portal,
# чтобы подписаться на сигнал Response до совершения вызова (защита от race condition)
token = f"shot_{GLib.random_int()}"
sender = bus.get_unique_name()[1:].replace(".", "_")
req_path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"

bus.signal_subscribe(
    "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.Request",
    "Response",
    req_path,
    None,
    Gio.DBusSignalFlags.NO_MATCH_RULE,
    on_response
)

proxy = Gio.DBusProxy.new_sync(
    bus, Gio.DBusProxyFlags.NONE, None,
    "org.freedesktop.portal.Desktop",
    "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.Screenshot",
    None
)

# Таймаут на случай отсутствия ответа от портала
GLib.timeout_add_seconds(10, lambda: (loop.quit(), False)[1])

ret = proxy.call_sync(
    "Screenshot",
    GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)})),
    Gio.DBusCallFlags.NONE, -1, None
)

if ret and ret[0] != req_path:
    bus.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        ret[0],
        None,
        Gio.DBusSignalFlags.NO_MATCH_RULE,
        on_response
    )

loop.run()
if not success:
    sys.exit(1)
`;

const toolkits = {
  spectacle: (file, multi, exec) =>
    exec('spectacle', ['-b', '-n', multi ? '-m' : '-f', '-o', file]),

  portal: (file, multi, exec) =>
    exec('python3', ['-c', PORTAL_SCREENSHOT_SCRIPT, file]),

  grim: (file, multi, exec) =>
    exec('grim', [file]),
};

// Check environment
function getPreferredOrder() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();

  // KDE Plasma
  if (desktop.includes('kde')) {
    return ['spectacle', 'portal', 'grim'];
  }

  // Tiling / wlroots (Hyprland, Sway, Niri, etc)
  if (desktop.includes('sway') || desktop.includes('hyprland') || desktop.includes('wlroots')) {
    return ['grim', 'portal', 'spectacle'];
  }

  // GNOME (XFCE, Cosmic, Flatpak, etc)
  return ['portal', 'spectacle', 'grim'];
}

// multi: more than one screen, so only the one the pointer is on (-m); else the whole desktop (-f)
async function grab({ multi = false, exec = run, nativeImage = require('electron').nativeImage } = {}) {
  const file = path.join(os.tmpdir(), `capri-shot-${randomUUID()}.png`);
  const methods = getPreferredOrder();
  try {
    for (const method of methods) {
      try {
        await toolkits[method](file, multi, exec);
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) return image;
      } catch {
        // tool error or missing, trying next
      }
    }
    return null;
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

module.exports = { grab };
