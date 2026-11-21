'use strict';

// The architecture rules as regexes over the source text, with a ratchet. Every violation that
// exists today is written down in debt.json; the list may only shrink. A violation that is not in
// the debt fails the test, and a debt entry that no longer matches anything fails it too, so the
// list cannot quietly go stale while the code moves on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// file paths are relative to the repository root, with forward slashes
const RULES = [
  {
    id: 'R1',
    forbid: /(?:process\.env|\benv)\.(?:XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|WAYLAND_DISPLAY|KDE_SESSION_VERSION)\b|['"]ozone-platform['"]/,
    allow: [/^src\/main\/core\/env\.js$/],
  },
  {
    id: 'R2',
    forbid: /require\((['"])electron\1\)/,
    allow: [/^src\/main\/app\//, /^src\/main\/main\.js$/, /^src\/(settings-)?preload\.js$/],
  },
  {
    id: 'R3',
    forbid: /require\((['"])(?:koffi|(?:node:)?child_process)\1\)|require\(['"][^'"]*dbus-mini(?:\.js)?['"]\)/,
    allow: [/^src\/main\/platform\/agent\//, /^src\/main\/features\/chat\//],
  },
  {
    id: 'R4',
    forbid: /require\(['"]\.\.?\/(?:[^'"]*\/)?(?:features|app)\//,
    allow: [/^src\/main\/app\//, /^src\/main\/main\.js$/],
  },
  {
    id: 'R5',
    forbid: /function\s+(?:pxToDip|dipToPx|toXPixels|toDip|toLocal)\b/,
    allow: [/^src\/main\/core\/geometry\.js$/, /^src\/main\/platform\/agent\/backends\/[^/]+\/geometry\.js$/],
  },
];

function violations(file, text) {
  return RULES
    .filter((r) => r.forbid.test(text) && !r.allow.some((a) => a.test(file)))
    .map((r) => ({ file, rule: r.id }));
}

function* jsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(full);
    else if (e.name.endsWith('.js')) yield full;
  }
}

const order = (a, b) => (a.file === b.file
  ? (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  : a.file < b.file ? -1 : 1);

function scan() {
  const out = [];
  for (const full of jsFiles(path.join(ROOT, 'src'))) {
    const file = path.relative(ROOT, full).split(path.sep).join('/');
    out.push(...violations(file, fs.readFileSync(full, 'utf8')));
  }
  return out.sort(order);
}

const readDebt = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'debt.json'), 'utf8'));
const key = (v) => `${v.file} ${v.rule}`;

// ---------- the matcher itself ----------

const SAMPLES = {
  R1: ['const d = process.env.XDG_CURRENT_DESKTOP;', 'const s = env.XDG_SESSION_TYPE;', "app.commandLine.getSwitchValue('ozone-platform')"],
  R2: ["const { app } = require('electron');"],
  R3: ["const { execFile } = require('node:child_process');", "const koffi = require('koffi');", "const { Bus } = require('./dbus-mini');"],
  R4: ["const chat = require('./features/chat');", "const tray = require('../app/tray');"],
  R5: ['function pxToDip(r, displays) { return r; }', 'function toXPixels(r, o, u) { return r; }'],
};
const EXEMPT = {
  R1: 'src/main/core/env.js',
  R2: 'src/main/app/tray.js',
  R3: 'src/main/platform/agent/services/media.js',
  R4: 'src/main/app/ipc/channels/chat.js',
  R5: 'src/main/platform/agent/backends/x11/geometry.js',
};

test('every rule catches its patterns, and only outside the allowed paths', () => {
  for (const r of RULES) {
    for (const snippet of SAMPLES[r.id]) {
      assert.deepEqual(violations('src/main/legacy.js', snippet).map((v) => v.rule), [r.id], `${r.id}: ${snippet}`);
      assert.deepEqual(violations(EXEMPT[r.id], snippet), [], `${r.id} exempt: ${snippet}`);
    }
  }
});

test('a require of electron-updater is not a require of electron', () => {
  assert.deepEqual(violations('src/main/legacy.js', "require('electron-updater')"), []);
});

// ---------- the ratchet ----------

test('the source tree violates exactly what the debt lists', () => {
  const debt = readDebt();
  const found = scan();
  const known = new Set(debt.map(key));
  const actual = new Set(found.map(key));
  const fresh = found.filter((v) => !known.has(key(v)));
  const stale = debt.filter((d) => !actual.has(key(d)));
  assert.deepEqual(fresh, [], 'new violations: fix them, or add them to debt.json deliberately');
  assert.deepEqual(stale, [], 'stale debt: these are fixed, remove them from debt.json');
});

test('debt.json is sorted, unique, and shaped {file, rule}', () => {
  const debt = readDebt();
  for (const d of debt) {
    assert.deepEqual(Object.keys(d).sort(), ['file', 'rule']);
    assert.ok(RULES.some((r) => r.id === d.rule), d.rule);
    assert.ok(d.file.startsWith('src/') && d.file.endsWith('.js'), d.file);
  }
  assert.deepEqual([...debt].sort(order), debt);
  assert.equal(new Set(debt.map(key)).size, debt.length);
});