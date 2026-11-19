'use strict';

// A picture of the screen on Linux. The stack of methods is put together outside, by the wiring:
// what the running adapter offers first, then what this display server can do on its own. This
// file runs the stack in order and returns the first picture that came out; it never looks at
// the desktop's name.
//
//   spectacle  KDE's own tool, taking it from KWin with no prompt (an adapter's method)
//   portal     xdg-desktop-portal: the standard Wayland way, may put a dialog up
//   capturer   Electron's desktopCapturer, the X11 way. Under XWayland it sees only the X windows,
//              and on native Wayland it comes out empty

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

# We generate a token and a path to the Request object in accordance with the XDG Portal specification,
# to subscribe to the Response signal before making the call (protection against race conditions)
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

# Timeout in case of no response from the portal
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

// What each display server can do by itself, with no adapter around.
const BASE_METHODS = {
  wayland: ['portal'],
  xwayland: ['capturer'],
  x11: ['capturer'],
  none: [],
};

const toolkits = {
  spectacle: (file, multi, exec) =>
    exec('spectacle', ['-b', '-n', multi ? '-m' : '-f', '-o', file]),

  portal: (file, multi, exec) =>
    exec('python3', ['-c', PORTAL_SCREENSHOT_SCRIPT, file]),
};

// One screen at its own pixels, through Electron. `display`: the screen to take.
async function fromCapturer({ display, capturer }) {
  if (!display) throw new Error('no display to capture');
  const k = display.scaleFactor || 1;
  const size = { width: Math.round(display.bounds.width * k), height: Math.round(display.bounds.height * k) };
  const sources = await capturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('no picture of the screen');
  return src.thumbnail;
}
// methods: the stack to try, in order.
// multi: more than one screen, so only the one the pointer is on (-m); else the whole desktop (-f)
async function grab({
  methods = [], multi = false, display = null, exec = run,
  nativeImage = require('electron').nativeImage,
  capturer = require('electron').desktopCapturer,
} = {}) {
  const file = path.join(os.tmpdir(), `capri-shot-${randomUUID()}.png`);
  try {
    for (const method of methods) {
      try {
        let image = null;
        if (method === 'capturer') {
          image = await fromCapturer({ display, capturer });
        } else if (toolkits[method]) {
          await toolkits[method](file, multi, exec);
          image = nativeImage.createFromPath(file);
        }
        if (image && !image.isEmpty()) return image;
      } catch {
        // this method is not there, or failed: the next one in the stack
      }
    }
    return null;
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

module.exports = { grab, BASE_METHODS };
