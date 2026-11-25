'use strict';

// The environment that decides policy is read in one place, core/env.js. main.js takes its facts
// from detectEnv there, and no application file reads those variables directly. This pins the
// wiring (detectEnv is actually called, not just imported) and keeps the R1 ratchet at zero:
// a new direct read cannot be parked in debt.json without failing here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('main.js gets its environment facts from detectEnv (core/env.js)', () => {
  const src = read('src/main/main.js');
  assert.match(src, /require\(['"]\.\/core\/env['"]\)/);
  assert.match(src, /detectEnv\(\{/);
  // the raw policy variables no longer appear in main.js
  assert.doesNotMatch(src, /process\.env\.(?:XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|WAYLAND_DISPLAY|KDE_SESSION_VERSION)\b/);
});

test('the policy variables are read only in core/env.js', () => {
  const forbid = /(?:process\.env|\benv)\.(?:XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|WAYLAND_DISPLAY|KDE_SESSION_VERSION)\b|['"]ozone-platform['"]/;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src', 'main'));
  const allowed = path.join(ROOT, 'src', 'main', 'core', 'env.js');
  const offenders = files
    .filter((f) => f !== allowed && forbid.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.deepEqual(offenders, []);
});

test('the ratchet: no R1 debt remains', () => {
  const debt = JSON.parse(read('tests/arch/debt.json'));
  assert.deepEqual(debt.filter((d) => d.rule === 'R1'), []);
});