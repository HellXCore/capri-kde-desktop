'use strict';

// The agent spike host: a standalone Electron app (scripts/, not product code).
// It launches the probe through utilityProcess and through child_process.fork
// (ELECTRON_RUN_AS_NODE=1), over every entry variant this build carries, and
// writes one JSON report. Run it with `npm run spike:agent` (dev) or
// `node scripts/agent-spike-build.js <out>` (packaged, asar matrix).

const { app, utilityProcess } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { classifyEntry, firstFailure, verdict } = require('./report.js');

const TIMEOUT_MS = 15000;
const ROOT = path.resolve(__dirname, '..', '..'); // dev layout: scripts/agent-spike

app.on('window-all-closed', () => {}); // no windows are ever opened; stay alive

// What to probe, per entry variant. Dev: the plain checkout. Packaged: the
// same probe reachable through the archive and through its unpacked mirror.
function variants() {
  if (!app.isPackaged) {
    return [{
      entry: path.join(__dirname, 'probe.js'),
      dbus: path.join(ROOT, 'src', 'main', 'linux', 'dbus-mini.js'),
      koffi: require.resolve('koffi'),
    }];
  }
  const res = process.resourcesPath;
  return ['app.asar', 'app.asar.unpacked'].map((side) => ({
    entry: path.join(res, side, side === 'app.asar' ? 'probe.js' : 'probe-unpacked.js'),
    dbus: path.join(res, side, 'dbus-mini.js'),
    koffi: path.join(res, side, 'node_modules', 'koffi'),
  }));
}

function launch(launcher, v) {
  const env = { ...process.env, CAPRI_SPIKE_OPTS: JSON.stringify(v) };
  delete env.ELECTRON_RUN_AS_NODE;
  if (launcher === 'utility') return utilityProcess.fork(v.entry, [], { env, stdio: 'pipe' });
  env.ELECTRON_RUN_AS_NODE = '1'; // the same binary as a plain Node process
  return fork(v.entry, [], { env, execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}

// MessagePortMain and child_process have spelled the 'message' payload
// differently across versions; accept both the value and a { data } wrapper.
const unwrap = (m) => (m && typeof m === 'object' && m.kind === undefined && m.data && typeof m.data === 'object' ? m.data : m);

const send = (child, launcher, m) => {
  try { launcher === 'utility' ? child.postMessage(m) : child.send(m); } catch { /* intentional: the exit path settles the run */ }
};

function attempt(launcher, v) {
  return new Promise((resolve) => {
    const run = {
      launcher, entry: classifyEntry(v.entry), entryPath: v.entry,
      ok: false, readyMs: null, rssMB: null, exitCode: null, probes: null, error: null, stderr: '',
    };
    const t0 = Date.now();
    let child;
    let settled = false;
    let ready = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(run); } };
    const timer = setTimeout(() => {
      run.error = run.error || `timeout after ${TIMEOUT_MS} ms`;
      try { child.kill(); } catch { /* intentional: the child may already be gone */ }
      setTimeout(finish, 500).unref();
    }, TIMEOUT_MS);

    try { child = launch(launcher, v); } catch (err) {
      run.error = String(err.message || err);
      return finish();
    }
    const tap = (c) => { run.stderr = (run.stderr + c).slice(-2000); };
    child.stdout?.on('data', tap);
    child.stderr?.on('data', tap);
    child.on('message', (raw) => {
      const m = unwrap(raw);
      if (!m || m.kind !== 'ready' || ready) return;
      ready = true;
      run.readyMs = Date.now() - t0;
      run.probes = m.probes || null;
      run.ok = Boolean(m.probes);
      run.error = m.error || null;
      run.rssMB = m.probes?.rssMB ?? null;
      send(child, launcher, { kind: 'shutdown' });
    });
    child.on('exit', (code) => {
      run.exitCode = code ?? null;
      if (!ready) run.error = run.error || `exited before ready (code ${code})`;
      finish();
    });
    child.on('error', (err) => { run.error = run.error || String(err.message || err); finish(); });
  });
}

app.whenReady().then(async () => {
  const runs = [];
  for (const v of variants()) {
    for (const launcher of ['utility', 'fork']) {
      const run = await attempt(launcher, v);
      runs.push(run);
      const said = run.ok
        ? `ready in ${run.readyMs} ms, rss ${run.rssMB} MB${run.probes.libx11.ok ? '' : ' (no X display)'}`
        : `FAILED: ${run.error || firstFailure(run)}`;
      console.log(`[spike] ${launcher}/${run.entry}: ${said}`);
    }
  }
  const report = {
    schema: 1,
    capturedAt: new Date().toISOString(),
    host: {
      electron: process.versions.electron, node: process.versions.node,
      packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      appPath: app.getAppPath(),
    },
    runs,
    verdict: verdict(runs, app.isPackaged),
  };
  const out = process.env.CAPRI_SPIKE_OUT
    || path.join(app.isPackaged ? process.cwd() : ROOT, 'docs', `agent-spike.${app.isPackaged ? 'packaged' : 'dev'}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[spike] verdict: ${report.verdict.utilityProcess}${report.verdict.fallback ? ` (fallback: ${report.verdict.fallback})` : ''}`);
  for (const why of report.verdict.reasons) console.log(`[spike]   ${why}`);
  console.log(`[spike] written: ${out}`);
  app.exit(0);
}).catch((err) => { console.error('[spike] failed:', err); app.exit(1); });