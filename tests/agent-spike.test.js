'use strict';

// The spike's pure half: the verdict rule is fixed before any measurement,
// so these tests pin the truth table the ADR's decision is read off — and
// the packaged snapshot's asar/unpack layout the fork fallback depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEntry, passing, firstFailure, verdict } = require('../scripts/agent-spike/report');
const { snapshotPackage, assertOutside, UNPACK } = require('../scripts/agent-spike-build');

const probe = (over = {}) => ({
  entry: { ok: true }, koffi: { ok: true }, libx11: { ok: true }, bus: { ok: true }, rssMB: 30, ...over,
});
const run = (launcher, entry, over = {}) => ({ launcher, entry, ok: true, probes: probe(), error: null, ...over });
const failed = (launcher, entry, error = 'boom') => ({ launcher, entry, ok: false, probes: null, error });

test('classifyEntry: asar, its unpacked mirror, plain paths (both separators)', () => {
  assert.equal(classifyEntry('/app/resources/app.asar/probe.js'), 'asar');
  assert.equal(classifyEntry('/app/resources/app.asar.unpacked/probe-unpacked.js'), 'unpacked');
  assert.equal(classifyEntry('C:\\app\\resources\\app.asar\\probe.js'), 'asar');
  assert.equal(classifyEntry('C:\\app\\resources\\app.asar.unpacked\\probe.js'), 'unpacked');
  assert.equal(classifyEntry('/repo/scripts/agent-spike/probe.js'), 'plain');
});

test('passing: entry + koffi + bus are hard; libX11 is informative only', () => {
  assert.equal(passing(run('utility', 'asar')), true);
  assert.equal(passing(run('utility', 'asar', { probes: probe({ libx11: { ok: false, error: 'no display' } }) })), true);
  for (const k of ['entry', 'koffi', 'bus']) {
    assert.equal(passing(run('utility', 'asar', { probes: probe({ [k]: { ok: false, error: 'x' } }) })), false, k);
  }
  assert.equal(passing(failed('utility', 'asar')), false);
  assert.equal(passing(null), false);
});

test('firstFailure names the probe, or the missing ready', () => {
  assert.equal(firstFailure({ probes: probe({ bus: { ok: false, error: 'no bus' } }) }), 'bus: no bus');
  assert.equal(firstFailure({ probes: null }), 'no ready message');
});

test('verdict: a passing packaged utility run is "suitable"; asar entry needs no unpack note', () => {
  const v = verdict([run('utility', 'asar'), failed('fork', 'asar')], true);
  assert.equal(v.utilityProcess, 'suitable');
  assert.equal(v.fallback, null);
  assert.match(v.reasons[0], /inside app\.asar/);
});

test('verdict: unpacked-only utility passes are "suitable" with the asarUnpack requirement', () => {
  const v = verdict([failed('utility', 'asar'), run('utility', 'unpacked')], true);
  assert.equal(v.utilityProcess, 'suitable');
  assert.match(v.reasons.join('\n'), /asarUnpack/);
});

test('verdict: a dev-only pass is inconclusive until the packaged matrix runs', () => {
  const v = verdict([run('utility', 'plain'), run('fork', 'plain')], false);
  assert.equal(v.utilityProcess, 'inconclusive');
  assert.match(v.reasons.join('\n'), /packaged/);
});

test('verdict: utility fails while fork passes the same environment: fork is the fallback', () => {
  const v = verdict([
    failed('utility', 'asar', 'exited before ready (code 1)'),
    failed('utility', 'unpacked', 'timeout after 15000 ms'),
    failed('fork', 'asar'),
    run('fork', 'unpacked'),
  ], true);
  assert.equal(v.utilityProcess, 'unsuitable');
  assert.equal(v.fallback, 'child_process.fork');
  assert.match(v.reasons.join('\n'), /utility\/asar: exited before ready/);
  assert.match(v.reasons.join('\n'), /fork passes \(unpacked\)/);
});

test('verdict: nothing passes (no bus anywhere) is inconclusive, not a decision', () => {
  const noBus = { probes: probe({ bus: { ok: false, error: 'no session bus' } }) };
  const v = verdict([
    run('utility', 'asar', noBus), run('utility', 'unpacked', noBus),
    run('fork', 'unpacked', noBus),
  ], true);
  assert.equal(v.utilityProcess, 'inconclusive');
  assert.equal(v.fallback, null);
  assert.match(v.reasons.join('\n'), /environment prerequisites/);
});

test('verdict: no utility runs at all is inconclusive', () => {
  const v = verdict([run('fork', 'unpacked')], true);
  assert.equal(v.utilityProcess, 'inconclusive');
});

test('snapshotPackage: the fork fallback has everything it needs on disk', () => {
  const pkg = snapshotPackage({ dependencies: { koffi: '^3.3.5' }, devDependencies: { electron: '^44.9.3' } });
  assert.equal(pkg.main, 'host.js');
  assert.equal(pkg.dependencies.koffi, '^3.3.5');
  assert.equal(pkg.devDependencies.electron, '^44.9.3');
  assert.equal(pkg.build.asar, true);
  assert.deepEqual(pkg.build.asarUnpack, UNPACK);
  // the entry, its shared code, the bus client and the whole native package:
  // RUN_AS_NODE cannot read any of them from inside the archive
  for (const need of ['probe-unpacked.js', 'probes.js', 'dbus-mini.js', 'node_modules/koffi/**']) {
    assert.ok(UNPACK.includes(need), need);
  }
  assert.deepEqual(pkg.build.linux.target, ['dir']);
});

test('assertOutside: the checkout and its children are refused, a sibling is fine', () => {
  assert.throws(() => assertOutside('/repo', '/repo'), /outside the checkout/);
  assert.throws(() => assertOutside('/repo', '/repo/dist/spike'), /outside the checkout/);
  assert.throws(() => assertOutside('/repo', ''), /outside the checkout/);
  assert.equal(assertOutside('/repo', '/tmp/capri-spike'), '/tmp/capri-spike');
});