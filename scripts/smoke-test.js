'use strict';

// Runs the actual main/preload/renderer, without installing hooks or calling AI providers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const packaged = process.argv[2];
const executable = packaged ? path.resolve(packaged) : require('electron');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-smoke-'));
const env = { ...process.env, CAPRI_SMOKE_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [...(packaged ? [] : [root]), '--smoke-test'], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let ready = false;
let settings = false; // her settings window opened, came back once, and closed on Escape
let out = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  out += String(chunk);
  if (out.includes('[capri] smoke ready:')) ready = true;
  if (out.includes('[capri] smoke settings: ok')) settings = true;
});
child.stderr.pipe(process.stderr);
const timer = setTimeout(() => { console.error('Smoke process did not exit'); child.kill('SIGKILL'); }, 45000);
child.on('error', (err) => { console.error(err); process.exitCode = 1; clearTimeout(timer); fs.rmSync(data, { recursive: true, force: true }); });
child.on('close', (code) => {
  clearTimeout(timer);
  fs.rmSync(data, { recursive: true, force: true });
  if (code !== 0 || !ready || !settings) {
    console.error(`Smoke failed: exit=${code}, rendererReady=${ready}, settingsWindow=${settings}`);
    process.exitCode = 1;
  }
});
