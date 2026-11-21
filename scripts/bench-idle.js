'use strict';

// Idle benchmark: CPU/RSS per process type, rAF rate, startup milestones and
// window-move -> renderer latency. Drives a private app instance through the
// existing --dev HTTP routes; the app's own code is never modified.
//
//   npm run bench                                    # writes docs/baseline.json
//   npm run bench -- --out docs/baseline.x11.json    # one file per session
//
// Linux only: per-process CPU/RSS are sampled from /proc (there is no main-process
// debug route, and /proc needs no app changes). Run once per session you want to
// pin (X11, KDE Wayland) and commit the JSONs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = require('../package.json');
const HZ = 100;          // USER_HZ on Linux
const PAGE = 4096;       // bytes per page
const MB = 1024 * 1024;
const SETTLE_MS = 10000; // let the entrance, panels and first polls settle
const RAF_MS = 5000;

const round = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pure helpers (unit-tested) ----------

function parseArgs(argv) {
  const out = { out: 'docs/baseline.json', seconds: 60, reps: 100, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--out') out.out = String(argv[++i] || '');
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--reps') out.reps = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.out) throw new Error('--out needs a file name');
  if (!(out.seconds >= 5 && out.seconds <= 600)) throw new Error('--seconds must be 5..600');
  if (!(out.reps >= 0 && out.reps <= 1000)) throw new Error('--reps must be 0..1000');
  return out;
}

// Chromium marks its child processes with --type=; the browser process has none.
function classify(cmdline) {
  const m = /--type=([a-z-]+)/.exec(cmdline);
  if (!m) return 'browser';
  if (m[1] === 'gpu-process') return 'gpu';
  if (['renderer', 'utility', 'zygote'].includes(m[1])) return m[1];
  return 'other';
}

// /proc/<pid>/stat, read from the end of the (possibly parenthesised) comm field:
// ppid is field 4, utime 14, stime 15, rss 24 (pages).
function statFields(text) {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  if (f.length < 22) return null;
  const n = (i) => Number(f[i]);
  if (!Number.isFinite(n(1)) || !Number.isFinite(n(11)) || !Number.isFinite(n(21))) return null;
  return { ppid: n(1), jiffies: n(11) + n(12), rssPages: n(21) };
}

// The root pid and every descendant, from a flat [{pid, ppid}] list.
function family(root, procs) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const out = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    for (const k of kids.get(pid) || []) stack.push(k);
  }
  return out;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// samples: [{t, procs:[{pid,type,jiffies,rssPages}]}] over windowMs.
// CPU: per pid, last-minus-first jiffies (a pid born mid-window counts from its
// first sample). RSS: per-sample sums per type, averaged and maxed.
function summarize(samples, windowMs) {
  const first = new Map();
  const last = new Map();
  const rssSum = {};
  const rssMax = {};
  for (const s of samples) {
    const per = { total: 0 };
    for (const p of s.procs) {
      if (!first.has(p.pid)) first.set(p.pid, p);
      last.set(p.pid, p);
      const bytes = p.rssPages * PAGE;
      per[p.type] = (per[p.type] || 0) + bytes;
      per.total += bytes;
    }
    for (const [t, bytes] of Object.entries(per)) {
      rssSum[t] = (rssSum[t] || 0) + bytes;
      rssMax[t] = Math.max(rssMax[t] || 0, bytes);
    }
  }
  const cpu = { total: 0 };
  for (const [pid, a] of first) {
    const b = last.get(pid);
    const d = Math.max(0, b.jiffies - a.jiffies);
    cpu[b.type] = (cpu[b.type] || 0) + d;
    cpu.total += d;
  }
  const sec = windowMs / 1000;
  const n = samples.length || 1;
  const out = {};
  for (const t of new Set([...Object.keys(cpu), ...Object.keys(rssSum)])) {
    out[t] = {
      cpuPct: round(((cpu[t] || 0) / HZ / sec) * 100),
      rssAvgMB: round((rssSum[t] || 0) / n / MB),
      rssMaxMB: round((rssMax[t] || 0) / MB),
    };
  }
  return out;
}

// The startup line main.js writes: "[capri] display: wayland-kde (server=...)".
function parseMode(log) {
  const m = /\[capri\] display: ([a-z0-9-]+) \(/i.exec(log);
  return m ? m[1] : null;
}

// ---------- runtime ----------

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method, timeout: 15000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error(`bad reply from ${route}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${route} timed out`)));
    req.on('error', reject);
    req.end(data);
  });
}
const post = (port, route, body) => request(port, 'POST', `/debug/${route}`, body);
async function evalJs(port, js) {
  const r = await post(port, 'eval', { js });
  if (!r || r.ok !== true) throw new Error(`eval failed: ${r && r.error}`);
  return r.value;
}
async function until(fn, ms, step = 200) {
  const t0 = performance.now();
  for (;;) {
    if (await fn()) return;
    if (performance.now() - t0 > ms) throw new Error('timed out waiting for the app');
    await sleep(step);
  }
}
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

function procTree(rootPid, typeCache) {
  const entries = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = statFields(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (st) entries.push({ pid: Number(name), ...st });
    } catch {
      // intentional: a process exited between readdir and read
    }
  }
  const mine = new Set(family(rootPid, entries));
  const out = [];
  for (const e of entries) {
    if (!mine.has(e.pid)) continue;
    let type = typeCache.get(e.pid);
    if (!type) {
      try { type = classify(fs.readFileSync(`/proc/${e.pid}/cmdline`, 'utf8')); } catch {
        // intentional: gone meanwhile; it still counts, as 'other'
        type = 'other';
      }
      typeCache.set(e.pid, type);
    }
    out.push({ pid: e.pid, type, jiffies: e.jiffies, rssPages: e.rssPages });
  }
  return out;
}

const READY = 'Boolean(window.dev && window.dev.capri && !window.dev.capri.busy && window.dev.capri.p.alpha > 0.9)';
const RAF_INSTALL = `(() => {
  if (window.__rafProbe) return false;
  const orig = window.requestAnimationFrame.bind(window);
  let n = 0;
  window.requestAnimationFrame = (fn) => orig((t) => { n += 1; fn(t); });
  window.__rafProbe = { count: () => n, stop: () => { window.requestAnimationFrame = orig; delete window.__rafProbe; } };
  return true;
})()`;

async function measureRaf(port) {
  await evalJs(port, RAF_INSTALL);
  try {
    await sleep(RAF_MS);
    const callbacks = await evalJs(port, 'window.__rafProbe ? window.__rafProbe.count() : null');
    return { windowMs: RAF_MS, callbacks, perSecond: round(callbacks / (RAF_MS / 1000)) };
  } finally {
    await evalJs(port, 'window.__rafProbe && window.__rafProbe.stop()').catch(() => {});
  }
}

async function measureMove(port, reps) {
  if (reps === 0) return { reps: 0, skipped: 'disabled (--reps 0)' };
  const tracked = await evalJs(port, 'Boolean(window.dev.brain.caps && window.dev.brain.caps.windows)');
  if (!tracked) return { reps: 0, skipped: 'windowTracking unavailable in this mode' };
  const before = await evalJs(port, 'window.dev.capri.windows.wins.length');
  await post(port, 'testwin', { open: true, id: 'bench', w: 720, h: 380 });
  try {
    await until(() => evalJs(port, 'window.dev.capri.windows.wins.length').then((n) => n > before), 6000, 150);
  } catch {
    await post(port, 'testwin', { open: false }).catch(() => {});
    return { reps: 0, skipped: 'the test window never showed up in the frame' };
  }
  // Resolve on the next frame whose windows actually differ from the armed base.
  await evalJs(port, `(() => {
    window.__benchNext = () => new Promise((res) => {
      const base = JSON.stringify(window.dev.capri.windows.wins);
      const off = window.host.onWindows((d) => {
        if (JSON.stringify(d.wins) === base) return;
        off(); res(true);
      });
    });
    return true;
  })()`);
  const lat = [];
  let fails = 0;
  for (let i = 0; i < reps && fails < 3; i++) {
    try {
      await evalJs(port, 'window.__benchPending = window.__benchNext(); true');
      const t0 = performance.now();
      await post(port, 'movewin', { id: 'bench', dx: i % 2 ? -24 : 24 });
      await evalJs(port, 'window.__benchPending');
      lat.push(performance.now() - t0);
      fails = 0;
    } catch {
      // intentional: a missed update is a failed repetition, not a dead benchmark
      fails += 1;
    }
  }
  await post(port, 'testwin', { open: false }).catch(() => {});
  if (!lat.length) return { reps: 0, skipped: 'no window updates observed' };
  return { reps: lat.length, p50Ms: round(percentile(lat, 50)), p95Ms: round(percentile(lat, 95)), maxMs: round(Math.max(...lat)) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/bench-idle.js [--out file] [--seconds 60] [--reps 100]');
    return;
  }
  if (process.platform !== 'linux') throw new Error('the benchmark reads /proc: Linux only');
  const electron = process.env.ELECTRON_PATH || require('electron');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-bench-'));
  const appDir = path.join(profile, PKG.productName || PKG.name);
  fs.mkdirSync(appDir, { recursive: true });
  // A settled profile: no welcome guide, no assistant events, no audio CPU.
  fs.writeFileSync(path.join(appDir, 'config.json'), JSON.stringify({ welcomed: true, claude: false, muted: true }));

  const env = { ...process.env, XDG_CONFIG_HOME: profile, CAPRI_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const tSpawn = performance.now();
  const child = spawn(electron, [ROOT, '--dev'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.once('exit', r));
  let log = '';
  let mode = null;
  const tap = (c) => { log += c; if (!mode) mode = parseMode(log); if (log.length > 200000) log = log.slice(-100000); };
  child.stdout.on('data', tap);
  child.stderr.on('data', tap);

  try {
    await until(async () => (await request(port, 'GET', '/health').catch(() => null))?.ok === true, 30000);
    const tBridge = performance.now();
    console.log(`[bench] mode: ${mode || '?'} (port ${port})`);
    await until(() => evalJs(port, 'Boolean(window.dev)').catch(() => false), 30000);
    const tBoot = performance.now();
    await until(() => evalJs(port, READY).catch(() => false), 45000);
    const tReady = performance.now();
    console.log(`[bench] ready in ${round(tReady - tSpawn)} ms; settling ${SETTLE_MS / 1000} s`);
    await sleep(SETTLE_MS);

    const typeCache = new Map();
    const samples = [];
    for (let i = 0; i <= args.seconds; i++) {
      samples.push({ t: i * 1000, procs: procTree(child.pid, typeCache) });
      if (i < args.seconds) await sleep(1000);
    }
    const idle = { windowMs: args.seconds * 1000, sampleMs: 1000, processes: summarize(samples, args.seconds * 1000) };
    console.log(`[bench] idle: total cpu ${idle.processes.total.cpuPct}%, rss avg ${idle.processes.total.rssAvgMB} MB`);

    const raf = await measureRaf(port);
    const move = await measureMove(port, args.reps);
    console.log(`[bench] rAF ${raf.perSecond}/s; move p50=${move.p50Ms ?? '-'} p95=${move.p95Ms ?? '-'} ms${move.skipped ? ` (${move.skipped})` : ''}`);

    let electronVersion = null;
    try { electronVersion = require('electron/package.json').version; } catch {
      // intentional: the devDependency may be pruned; the report says null then
    }
    const report = {
      schema: 1,
      capturedAt: new Date().toISOString(),
      machine: { cpu: os.cpus()[0]?.model || null, cores: os.cpus().length, ramGB: round(os.totalmem() / 1e9), kernel: os.release(), arch: process.arch },
      app: { version: PKG.version, electron: electronVersion, runnerNode: process.versions.node },
      session: {
        mode, xdgSessionType: process.env.XDG_SESSION_TYPE ?? null, desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
        waylandDisplay: Boolean(process.env.WAYLAND_DISPLAY), display: process.env.DISPLAY ?? null,
        forcedMode: process.env.CAPRI_FORCE_MODE ?? null,
      },
      profile: { isolated: true, welcomed: true, claude: false, muted: true },
      startup: { toBridgeMs: round(tBridge - tSpawn), toBootMs: round(tBoot - tSpawn), toReadyMs: round(tReady - tSpawn) },
      idle, raf, move,
      notes: [
        'CPU/RSS sampled from /proc per process type; the app code is unmodified.',
        'toReadyMs approximates renderer:ready (entrance finished: busy=false, alpha>0.9).',
        'Idle includes her own wander and animation; compare like-for-like sessions only.',
      ],
    };
    const out = path.resolve(ROOT, args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[bench] written: ${path.relative(ROOT, out)}`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(5000).then(() => child.kill('SIGKILL'))]);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

module.exports = { parseArgs, classify, statFields, family, percentile, summarize, parseMode };
if (require.main === module) {
  main().catch((err) => { console.error('[bench] failed:', err.message); process.exitCode = 1; });
}