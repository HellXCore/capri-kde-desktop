'use strict';

// The type check is only worth running if it actually checks: these pin the scope and the flags,
// so a loosened tsconfig cannot turn `npm run typecheck` into a green no-op.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const TYPED = ['src/main/core/**/*.js', 'src/main/platform/**/*.js', 'src/main/features/**/*.js'];

test('typecheck: checkJs and strict, and nothing is emitted', () => {
  const { compilerOptions: o } = readJson('tsconfig.json');
  assert.equal(o.allowJs, true);
  assert.equal(o.checkJs, true);
  assert.equal(o.strict, true);
  assert.equal(o.noEmit, true);
});

test('typecheck: only the typed layers are in the program', () => {
  assert.deepEqual(readJson('tsconfig.json').include, TYPED);
});

test('typecheck: the script runs this config, and the compiler is a devDependency', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.ok(pkg.devDependencies.typescript, 'typescript must be installed for the check to run');
  assert.ok(pkg.devDependencies['@types/node'], 'Buffer and the node globals come from here');
});

test('typecheck: the program has an input (the compiler refuses an empty one)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'src/main/core/ports.js')));
});