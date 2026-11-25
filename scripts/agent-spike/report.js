'use strict';

// Pure helpers of the agent spike: entry classification, run acceptance, verdict.
// No Electron, no I/O — unit-tested (tests/agent-spike.test.js). The verdict rule
// is fixed here BEFORE any measurement, so the numbers decide, not the mood.

/** Where an entry file lives: inside the archive, in its unpacked mirror, or plain. */
const classifyEntry = (p) => {
  const s = String(p).replace(/\\/g, '/');
  if (s.includes('app.asar.unpacked/')) return 'unpacked';
  if (s.includes('app.asar/')) return 'asar';
  return 'plain';
};

// A run answers the hard questions when the process came up, its entry was
// readable, koffi loaded and the session bus answered. libX11 is informative
// only: a Wayland-only machine may have no X display to open.
function passing(run) {
  const p = run && run.probes;
  return Boolean(run?.ok && p?.entry?.ok && p?.koffi?.ok && p?.bus?.ok);
}

function firstFailure(run) {
  const p = run.probes || {};
  for (const k of ['entry', 'koffi', 'bus']) if (p[k] && !p[k].ok) return `${k}: ${p[k].error}`;
  return 'no ready message';
}

/**
 * The pre-committed decision rule (docs/adr/011-agent-spike.md):
 *   suitable     — some utilityProcess run passes with a packaged entry;
 *   unsuitable   — every utilityProcess run failed while fork passed the same
 *                  environment: the launcher is at fault, fork is the fallback;
 *   inconclusive — nothing passed (environment missing?) or only the dev run
 *                  passed: measure again before deciding.
 */
function verdict(runs, packaged) {
  const utility = runs.filter((r) => r.launcher === 'utility');
  const forkRuns = runs.filter((r) => r.launcher === 'fork');
  const goodU = utility.filter(passing);
  const goodF = forkRuns.filter(passing);
  const reasons = [];

  if (goodU.length && goodU.some((r) => r.entry !== 'plain')) {
    const asar = goodU.some((r) => r.entry === 'asar');
    reasons.push(asar
      ? 'utilityProcess loads an entry inside app.asar'
      : 'utilityProcess works with an unpacked entry only: the agent entry and its libraries must be listed in asarUnpack');
    return { utilityProcess: 'suitable', fallback: null, reasons };
  }
  if (goodU.length && !packaged) {
    reasons.push('only the unpackaged (dev) run passed: the packaged matrix is required before deciding');
    return { utilityProcess: 'inconclusive', fallback: null, reasons };
  }
  for (const r of utility) reasons.push(`utility/${r.entry}: ${r.error || firstFailure(r)}`);
  if (utility.length && goodF.length) {
    reasons.push(`child_process.fork passes (${goodF.map((r) => r.entry).join(', ')}): the environment is fine, the launcher is not`);
    return { utilityProcess: 'unsuitable', fallback: 'child_process.fork', reasons };
  }
  reasons.push(utility.length
    ? 'no launcher passed: environment prerequisites missing (session bus? koffi installed?) — fix and rerun'
    : 'no utilityProcess runs recorded');
  return { utilityProcess: 'inconclusive', fallback: null, reasons };
}

module.exports = { classifyEntry, passing, firstFailure, verdict };