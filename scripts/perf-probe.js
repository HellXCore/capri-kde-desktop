#!/usr/bin/env node
'use strict';

// CPU / GPU / wakeup baseline of the overlay in fixed states (docs/PERFORMANCE.md). macOS only.
//   node scripts/perf-probe.js [--app <dir>] [--secs 60] [--warmup 10] [--port 47911] [--out file.json]
// Starts `electron <app> --dev` with a throwaway --user-data-dir and its own CAPRI_PORT (never your
// profile, never your hooks), drives it through the --dev debug routes and the hook bridge, and for
// every state samples, over the same window:
//   - CPU time of each Electron process (main, renderer, GPU, utility) and the window helper, from
//     `ps` cputime deltas (average % of one core);
//   - idle wakeups/s and energy impact, from `top`;
//   - GPU time the Electron GPU process submitted, from IOAccelerator's per-client AppUsage
//     (accumulatedGPUTime): % of GPU wall time; WindowServer's is also listed, but it composites
//     every app on screen, so it's context, not hers;
//   - inside the renderer: requestAnimationFrame callbacks and sprite draws per second. (IPC to main
//     can't be counted from here: contextBridge hands the page a frozen `host`.)
// The screen locked or the display off changes everything (WindowServer stops compositing): each
// window says whether it was, and --wait-unlock holds every state until the screen is unlocked.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync, execFile } = require('node:child_process');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const APP = path.resolve(arg('app', path.join(__dirname, '..')));
const SECS = Number(arg('secs', 60));
const WARMUP = Number(arg('warmup', 10));
const PORT = Number(arg('port', 47911));
const OUT = arg('out', null);
const ONLY = arg('states', null)?.split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const debug = (route, body = {}) => request('POST', `/debug/${route}`, body);
const evalJs = async (js) => (await debug('eval', { js })).value;
const command = (name, payload = {}) => debug('command', { name, ...payload });
const event = (name, extra = {}) => request('POST', '/event', {
  hook_event_name: name, session_id: 'perf-session', cwd: '/tmp/perf-project', demo: true, ...extra,
});

// ---------- process sampling ----------

const parseTime = (t) => t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);

function processes(mainPid) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,command=']).toString();
  const rows = out.trim().split('\n').map((line) => {
    const [, pid, ppid, time, rss, cmd] = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/) || [];
    return pid && { pid: Number(pid), ppid: Number(ppid), cpu: parseTime(time), rss: Number(rss), cmd };
  }).filter(Boolean);
  const kind = (cmd) => {
    if (cmd.includes('--type=gpu-process')) return 'gpu';
    if (cmd.includes('--type=renderer')) return 'renderer';
    if (cmd.includes('--type=utility')) return 'utility';
    if (cmd.includes('capri-windows')) return 'helper';
    return 'other';
  };
  return rows.filter((r) => r.pid === mainPid || r.ppid === mainPid)
    .map((r) => ({ ...r, kind: r.pid === mainPid ? 'main' : kind(r.cmd) }));
}

function gpuTimes() {
  // per-process GPU time (ns) from the accelerator's user clients
  const out = execFileSync('ioreg', ['-r', '-c', 'AGXDeviceUserClient', '-l'], { maxBuffer: 64 << 20 }).toString();
  const times = new Map();
  // one block per client; its creator may come before or after its AppUsage
  for (const block of out.split(/\+-o /).slice(1)) {
    const creator = block.match(/"IOUserClientCreator" = "pid (\d+),/);
    const usage = block.match(/"AppUsage" = \((.*)\)/);
    if (!creator || !usage) continue;
    const pid = Number(creator[1]);
    const sum = [...usage[1].matchAll(/"accumulatedGPUTime"=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    times.set(pid, (times.get(pid) || 0) + sum);
  }
  return times;
}

function topSample(pids, secs) {
  // two samples `secs` apart: idle wakeups are cumulative (delta), POWER is the interval's
  return new Promise((resolve) => {
    const args = ['-l', '2', '-s', String(secs), '-stats', 'pid,idlew,power'];
    for (const pid of pids) args.push('-pid', String(pid));
    execFile('top', args, { maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      const tables = stdout.split(/^PID\s+IDLEW\s+POWER\s*$/m).slice(1).map((t) => {
        const rows = new Map();
        for (const line of t.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\+?\s+([\d.]+)/);
          if (m) rows.set(Number(m[1]), { idlew: Number(m[2]), power: Number(m[3]) });
        }
        return rows;
      });
      if (tables.length < 2) return resolve(null);
      const res = new Map();
      for (const pid of pids) {
        const a = tables[0].get(pid), b = tables[1].get(pid);
        if (a && b) res.set(pid, { wakeups: (b.idlew - a.idlew) / secs, power: b.power });
      }
      resolve(res);
    });
  });
}

// Locked screen or display off: WindowServer stops drawing and so does a lot of Chromium, numbers
// taken then don't describe her on screen. The window is marked, and --wait-unlock waits it out.
function locked() {
  const out = execFileSync('ioreg', ['-n', 'Root', '-d1']).toString();
  return /"CGSSessionScreenIsLocked"=Yes/.test(out) || /"IOConsoleLocked" = Yes/.test(out);
}
const WAIT_UNLOCK = process.argv.includes('--wait-unlock');
async function whenUnlocked() {
  if (!WAIT_UNLOCK) return;
  if (locked()) console.log('screen locked: waiting');
  while (locked()) await sleep(5000);
}

const INSTRUMENT = `(() => {
  if (window.__perf) return true;
  const c = window.__perf = { raf: 0, draw: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => { c.raf++; fn(t); });
  const sprite = window.dev.capri.sprite;
  const draw = sprite.draw.bind(sprite);
  sprite.draw = (p) => { c.draw++; return draw(p); };
  return true;
})()`;
const COUNTERS = 'JSON.stringify(window.__perf)';

async function measure(mainPid, label) {
  const before = processes(mainPid);
  const gpuPid = before.find((p) => p.kind === 'gpu')?.pid;
  const ws = Number(execFileSync('pgrep', ['-x', 'WindowServer']).toString().trim().split('\n')[0]);
  const lockedBefore = locked();
  const g0 = gpuTimes();
  const c0 = JSON.parse(await evalJs(COUNTERS));
  const t0 = Date.now();
  const top = await topSample(before.map((p) => p.pid), SECS);
  const secs = (Date.now() - t0) / 1000;
  const c1 = JSON.parse(await evalJs(COUNTERS));
  // CSS animations running at the end of the window, and what she was doing (did the state hold?)
  const page = JSON.parse(await evalJs(`JSON.stringify({ css: document.getAnimations().filter((a) => a.playState === 'running').length,
    mode: window.dev.capri.mode, stance: window.dev.capri.stance, hidden: window.dev.capri.hidden, stowed: window.dev.capri.stowed,
    dormant: window.dev.capri.dormant, chat: window.dev.chat.open, motion: document.documentElement.dataset.motion })`));
  const g1 = gpuTimes();
  const after = processes(mainPid);
  const lockedAfter = locked();
  const rows = after.map((p) => {
    const b = before.find((q) => q.pid === p.pid);
    return {
      kind: p.kind, pid: p.pid, rssMB: Math.round(p.rss / 1024),
      cpu: b ? +((100 * (p.cpu - b.cpu)) / secs).toFixed(2) : null,
      wakeups: top?.get(p.pid) ? +top.get(p.pid).wakeups.toFixed(1) : null,
      power: top?.get(p.pid)?.power ?? null,
    };
  });
  const gpuPct = (pid) => (pid && g0.has(pid) && g1.has(pid) ? +((100 * (g1.get(pid) - g0.get(pid))) / (secs * 1e9)).toFixed(3) : null);
  const res = {
    state: label, secs: +secs.toFixed(1), screenLocked: lockedBefore || lockedAfter,
    cpuTotal: +rows.reduce((n, r) => n + (r.cpu || 0), 0).toFixed(2),
    wakeupsTotal: +rows.reduce((n, r) => n + (r.wakeups || 0), 0).toFixed(1),
    gpuProcGpu: gpuPct(gpuPid), windowServerGpu: gpuPct(ws),
    rafPerSec: +((c1.raf - c0.raf) / secs).toFixed(1), drawsPerSec: +((c1.draw - c0.draw) / secs).toFixed(1),
    page, rendererReplaced: !before.some((p) => p.kind === 'renderer' && after.some((q) => q.pid === p.pid)), processes: rows,
  };
  console.log(JSON.stringify({ state: res.state, locked: res.screenLocked, cpuTotal: res.cpuTotal, wakeups: res.wakeupsTotal, gpu: res.gpuProcGpu,
    raf: res.rafPerSec, draws: res.drawsPerSec, page, byKind: Object.fromEntries(rows.map((r) => [r.kind, r.cpu])) }));
  return res;
}

// ---------- states ----------

const PREP = `(() => { const d = window.dev; d.panel.hide(); d.capri.wake(); d.capri.lastActivity = performance.now();
  d.capri.nextMove = d.capri.nextGaze = Infinity; return d.capri.mode; })()`;

const STATES = {
  async idle() {
    await evalJs(PREP);
  },
  async work(ctl) {
    await evalJs(PREP);
    await event('SessionStart', { source: 'startup' });
    await sleep(500);
    await event('UserPromptSubmit', { prompt: 'Measure the overlay' });
    const tools = [['Read', { file_path: '/tmp/perf-project/a.js' }], ['Grep', { pattern: 'raf' }], ['Edit', { file_path: '/tmp/perf-project/a.js' }], ['Bash', { command: 'npm test' }]];
    let i = 0;
    ctl.loop = setInterval(() => {
      const [name, input] = tools[i++ % tools.length];
      event('PreToolUse', { tool_name: name, tool_input: input }).catch(() => {});
      setTimeout(() => event('PostToolUse', { tool_name: name, tool_input: input, duration_ms: 900 }).catch(() => {}), 1200);
    }, 2500);
  },
  async workEnd(ctl) {
    clearInterval(ctl.loop);
    await event('Stop', { last_assistant_message: 'Done.' });
    await sleep(3000);
  },
  async chat() {
    await evalJs(PREP);
    await command('chat');
  },
  async chatEnd() {
    await evalJs('window.dev.chat.close(); window.dev.panel.hide(); true');
  },
  async hidden() {
    await evalJs(PREP);
    await command('stow', { on: true });
  },
  async hiddenEnd() {
    await command('stow', { on: false });
    await sleep(4000);
  },
  async reduced() {
    await command('config', { patch: { motion: 'reduced' } });
    await sleep(500);
    await evalJs(PREP);
  },
  async reducedEnd() {
    await command('config', { patch: { motion: 'full' } });
  },
  async sleep() {
    // asleep (6 fps, dim), kept from coming apart into her mask for the whole window
    await evalJs(PREP);
    await evalJs("window.dev.capri.setMode('sleep'); window.dev.capri.sleptAt = performance.now() + 1e9; true");
  },
  async dozed() {
    // asleep long enough: down to her mask
    await evalJs('window.dev.capri.sleptAt = performance.now() - 60000; true');
  },
  async dozedEnd() {
    await evalJs('window.dev.capri.wake(); true');
    await sleep(4000);
  },
};
const ORDER = ['idle', 'work', 'chat', 'hidden', 'reduced', 'sleep', 'dozed'];

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-perf-'));
  // no first-run guide, no motion question: straight to the states
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    welcomed: true, motionAsked: true, motion: 'full', lang: 'en', assistant: 'claude', linked: true, initiative: 'quiet',
  }));
  const env = { ...process.env, CAPRI_PORT: String(PORT) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require(path.join(APP, 'node_modules', 'electron')), [APP, '--dev', `--user-data-dir=${data}`], {
    cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const stop = () => { try { child.kill(); } catch {} };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); fs.rmSync(data, { recursive: true, force: true }); process.exit(1); });
  try {
    for (let i = 0; ; i++) {
      if (i > 60) throw new Error(`never came up:\n${log}`);
      await sleep(1000);
      const ready = await evalJs('Boolean(window.dev && window.dev.capri && !window.dev.capri.busy)').catch(() => false);
      if (ready) break;
    }
    await sleep(8000); // past her intro and her hello
    // the throwaway profile is the one in use (its config says English, whatever the system says)
    if (await evalJs('window.dev.brain.lang') !== 'en') throw new Error('user data dir not used');
    await evalJs(INSTRUMENT);
    const info = await evalJs(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
      motion: document.documentElement.dataset.motion, gl: (() => { const gl = window.dev.capri.sprite.gl;
      const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })() })`);
    const display = (log.match(/\[capri\] display: (.*)/) || [])[1] || null;
    const results = { app: APP, when: new Date().toISOString(), secs: SECS, warmup: WARMUP, renderer: JSON.parse(info), display,
      windowTracking: (log.match(/\[capri\] window tracking: (\w+)/) || [])[1] || null, states: [] };
    console.log(JSON.stringify({ renderer: results.renderer, display }));
    for (const state of ORDER.filter((s) => !ONLY || ONLY.includes(s))) {
      await whenUnlocked();
      const ctl = {};
      await STATES[state](ctl);
      await sleep(WARMUP * 1000);
      results.states.push(await measure(child.pid, state));
      await STATES[`${state}End`]?.(ctl);
    }
    results.windowTracking = (log.match(/\[capri\] window tracking: (\w+)/) || [])[1] || null;
    results.errors = log.split('\n').filter((l) => /renderer:error|Uncaught|TypeError|renderer gone/.test(l)).slice(0, 20);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`electron output (tail):\n${log.slice(-3000)}\nexit: ${child.exitCode} ${child.signalCode}`);
    throw err;
  } finally {
    stop();
    await sleep(1500);
    fs.rmSync(data, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
