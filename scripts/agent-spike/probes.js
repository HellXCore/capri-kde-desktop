'use strict';

// The probe half of the agent spike: runs INSIDE a utilityProcess (or an
// ELECTRON_RUN_AS_NODE child), answers the spike's questions about its own
// process and reports them to the host. This is a throwaway measurement
// harness, not product code: koffi is required here directly precisely to
// see whether the module loads in this kind of process at all.
//
// Everything it needs is handed in through CAPRI_SPIKE_OPTS (absolute paths),
// so the same probe measures the asar entry and the unpacked one alike.

const fs = require('node:fs');

const opts = JSON.parse(process.env.CAPRI_SPIKE_OPTS || '{}');

function entryProbe() {
  try {
    const bytes = fs.readFileSync(opts.entry).length;
    return { ok: bytes > 0, file: opts.entry, bytes };
  } catch (err) {
    return { ok: false, file: opts.entry, error: String(err.message || err) };
  }
}

// koffi loading is a hard question; opening libX11 and a display is a bonus
// (it needs an X server, which a Wayland-only test machine may not have).
function nativeProbes() {
  const out = { koffi: { ok: false, path: opts.koffi }, libx11: { ok: false } };
  let koffi;
  try {
    koffi = require(opts.koffi);
    out.koffi = { ok: typeof koffi.load === 'function', path: opts.koffi, version: koffi.version ?? null };
  } catch (err) {
    out.koffi.error = String(err.message || err);
    return out;
  }
  try {
    const lib = koffi.load('libX11.so.6');
    const XOpenDisplay = lib.func('void *XOpenDisplay(const char *name)');
    const XCloseDisplay = lib.func('int XCloseDisplay(void *display)');
    const display = XOpenDisplay(null);
    if (!display) {
      out.libx11.error = 'XOpenDisplay failed (no X display in this session)';
      return out;
    }
    XCloseDisplay(display);
    out.libx11 = { ok: true };
  } catch (err) {
    out.libx11.error = String(err.message || err);
  }
  return out;
}

// The real dbus-mini (the very file the agent would carry), over the real
// session bus: unix socket, SASL EXTERNAL, Hello + one method call.
async function busProbe() {
  const t0 = Date.now();
  let bus;
  try {
    const { Bus } = require(opts.dbus);
    bus = await Bus.connect();
    const [names] = await bus.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus', member: 'ListNames',
    });
    return { ok: true, ms: Date.now() - t0, names: names.length, path: opts.dbus };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, path: opts.dbus, error: String(err.message || err) };
  } finally {
    try { bus?.close(); } catch { /* intentional: the probe is over either way */ }
  }
}

const port = process.parentPort || null; // MessagePortMain in a utility process, absent in a fork
const send = (m) => {
  try { port ? port.postMessage(m) : process.send(m); } catch { /* intentional: the host may be gone */ }
};
const onMessage = (fn) => (port ? port.on('message', (e) => fn(e.data)) : process.on('message', fn));
onMessage((m) => { if (m && m.kind === 'shutdown') process.exit(0); });

(async () => {
  const probes = {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      type: process.type ?? 'node',
      parentPort: Boolean(port),
      pid: process.pid,
    },
    entry: entryProbe(),
    ...nativeProbes(),
    bus: await busProbe(),
    rssMB: Math.round((process.memoryUsage().rss / 1048576) * 100) / 100,
  };
  send({ kind: 'ready', probes });
})().catch((err) => {
  send({ kind: 'ready', probes: null, error: String((err && err.stack) || err) });
});