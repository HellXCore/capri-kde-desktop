'use strict';

// Builds the agent spike as a packaged Electron app (asar + asarUnpack) and
// runs it, so the utilityProcess questions are answered on a real archive.
// Mirrors scripts/updater-smoke.js: an isolated copy outside the checkout,
// the repo's node_modules symlinked in, electron-builder from the repo.
//
//   node scripts/agent-spike-build.js <out>    build + run; report to docs/agent-spike.packaged.json
//
// The unpacked set is exactly what a fork-based agent would need on disk:
// ELECTRON_RUN_AS_NODE has no asar support, so the fallback entry, its shared
// probe code, dbus-mini and the whole koffi package must be outside the archive.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(__dirname, 'agent-spike');

const UNPACK = ['probe-unpacked.js', 'probes.js', 'dbus-mini.js', 'node_modules/koffi/**'];

function snapshotPackage(rootPkg) {
  return {
    name: 'capri-agent-spike',
    version: '0.0.0',
    private: true,
    main: 'host.js',
    dependencies: { koffi: rootPkg.dependencies.koffi },
    devDependencies: { electron: rootPkg.devDependencies.electron },
    build: {
      appId: 'com.arasaka.capricorn.agentspike',
      productName: 'capri-agent-spike',
      files: ['**/*'],
      asar: true,
      asarUnpack: UNPACK,
      linux: { target: ['dir'], category: 'Utility' },
    },
  };
}

function assertOutside(root, out) {
  const dir = path.resolve(out);
  if (!out || dir === root || dir.startsWith(root + path.sep)) throw new Error('Use a folder outside the checkout');
  return dir;
}

function main() {
  if (process.platform !== 'linux') throw new Error('Linux only');
  const out = assertOutside(ROOT, process.argv[2]);
  const appDir = path.join(out, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  for (const f of ['host.js', 'probe.js', 'probe-unpacked.js', 'probes.js', 'report.js']) {
    fs.copyFileSync(path.join(APP, f), path.join(appDir, f));
  }
  // the very dbus-mini the agent would carry, next to the entries
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'linux', 'dbus-mini.js'), path.join(appDir, 'dbus-mini.js'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(snapshotPackage(rootPkg), null, 2)}\n`);
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(appDir, 'node_modules'));

  console.log(`[spike-build] building in ${appDir}`);
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
    '--linux', 'dir', '--publish', 'never',
  ], { cwd: appDir, stdio: 'inherit' });

  const binary = path.join(appDir, 'dist', 'linux-unpacked', 'capri-agent-spike');
  const report = path.join(ROOT, 'docs', 'agent-spike.packaged.json');
  const env = { ...process.env, CAPRI_SPIKE_OUT: report };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [], { env, stdio: 'inherit' });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
}

module.exports = { snapshotPackage, assertOutside, UNPACK };
if (require.main === module) {
  try { main(); } catch (err) { console.error('[spike-build] failed:', err.message); process.exitCode = 1; }
}