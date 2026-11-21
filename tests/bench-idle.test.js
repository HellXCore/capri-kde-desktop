'use strict';

// The benchmark's pure half: argument parsing, /proc parsing, process-tree
// collection, percentiles and the idle summary. No Electron, no display, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, classify, statFields, family, percentile, summarize, parseMode } = require('../scripts/bench-idle');

test('args: defaults, overrides, and refusals', () => {
  assert.deepEqual(parseArgs([]), { out: 'docs/baseline.json', seconds: 60, reps: 100, help: false });
  assert.deepEqual(parseArgs(['--out', 'x.json', '--seconds', '5', '--reps', '3']),
    { out: 'x.json', seconds: 5, reps: 3, help: false });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['--seconds', '1']), /5\.\.600/);
  assert.throws(() => parseArgs(['--out']), /file name/);
});

test('classify: Chromium process types, the browser has none', () => {
  assert.equal(classify('/opt/electron/electron . --dev'), 'browser');
  assert.equal(classify('electron --type=renderer --lang=en'), 'renderer');
  assert.equal(classify('electron --type=gpu-process'), 'gpu');
  assert.equal(classify('electron --type=utility --utility-sub-type=network.mojom.NetworkService'), 'utility');
  assert.equal(classify('electron --type=zygote'), 'zygote');
  assert.equal(classify('electron --type=crashpad-handler'), 'other');
});

test('statFields: ppid, utime+stime, rss; comm with spaces and parens', () => {
  const f = ['S', '42', '999', '999', '0', '-1', '0', '0', '0', '0', '0', '100', '50', '0', '0', '20', '0', '1', '0', '0', '123456', '2048'];
  const st = statFields(`999 (capri (test)) ${f.join(' ')}`);
  assert.deepEqual(st, { ppid: 42, jiffies: 150, rssPages: 2048 });
  assert.equal(statFields('garbage'), null);
  assert.equal(statFields('1 (x) S 1'), null);
});

test('family: the root and its descendants, nobody else', () => {
  const procs = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 1 }];
  assert.deepEqual(family(10, procs).sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual(family(99, procs), [99]);
});

test('percentile: nearest rank, single value, empty', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
});

test('summarize: CPU over the window, RSS avg/max, a process born mid-window', () => {
  const p = (pid, type, jiffies, rssPages) => ({ pid, type, jiffies, rssPages });
  const samples = [
    { t: 0, procs: [p(10, 'browser', 0, 100), p(11, 'renderer', 0, 200)] },
    { t: 30000, procs: [p(10, 'browser', 300, 100), p(11, 'renderer', 150, 200), p(12, 'gpu', 50, 300)] },
    { t: 60000, procs: [p(10, 'browser', 600, 100), p(11, 'renderer', 300, 200), p(12, 'gpu', 150, 300)] },
  ];
  const s = summarize(samples, 60000);
  assert.equal(s.browser.cpuPct, 10);      // 600 jiffies = 6 s of 60
  assert.equal(s.renderer.cpuPct, 5);
  assert.equal(s.gpu.cpuPct, 1.67);        // born at t=30 s: 100 jiffies counted
  assert.equal(s.total.cpuPct, 16.67);
  assert.equal(s.browser.rssAvgMB, 0.39);
  assert.equal(s.gpu.rssAvgMB, 0.78);      // (0 + 300 + 300) pages / 3 samples
  assert.equal(s.total.rssAvgMB, 1.95);
  assert.equal(s.total.rssMaxMB, 2.34);    // max of per-sample totals, not sum of maxes
});

test('parseMode: the startup display line', () => {
  assert.equal(parseMode('[capri] display: wayland-kde (server=wayland, desktop=kde, Electron 44.9.3)'), 'wayland-kde');
  assert.equal(parseMode('[capri] display: x11 (server=x11, desktop=kde)'), 'x11');
  assert.equal(parseMode('[capri] listening on 127.0.0.1:47823'), null);
});