'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { verifyMacSignature } = require('../scripts/verify-mac-signature');

const bundle = path.join('test', 'Capri.app');
const details = 'Identifier=capri.desktop\nSealed Resources version=2 rules=13 files=25\n';
const success = (stderr = '') => ({ status: 0, stdout: '', stderr });

test('Mac release verifier checks nested code, the sealed Capri identity, and the native helper', () => {
  const calls = [];
  verifyMacSignature(bundle, { run(file, args) {
    assert.equal(file, '/usr/bin/codesign');
    calls.push(args);
    return success(args.includes('--display') ? details : '');
  } });
  assert.deepEqual(calls[0], ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  assert.deepEqual(calls[1], ['--display', '--verbose=4', bundle]);
  assert.deepEqual(calls[2], ['--verify', '--strict', '--verbose=2', path.join(bundle, 'Contents', 'Resources', 'bin', 'capri-windows')]);
});

test('Mac release verifier refuses broken signatures and missing codesign', () => {
  assert.throws(() => verifyMacSignature(bundle, { run: () => ({ status: 1, stderr: 'a sealed resource is missing or invalid' }) }), /missing or invalid/);
  assert.throws(() => verifyMacSignature(bundle, { run: () => ({ error: new Error('ENOENT') }) }), /ENOENT/);
});

test('Mac release verifier refuses the old Electron linker signature without sealed resources', () => {
  for (const metadata of ['Identifier=Electron\nSealed Resources=none\n', 'Identifier=capri.desktop\nSealed Resources=none\n']) {
    assert.throws(() => verifyMacSignature(bundle, { run: (_, args) => success(args.includes('--display') ? metadata : '') }), /sealed bundle resources/);
  }
});

test('Mac release verifier refuses a broken window helper even when the app seal is valid', () => {
  assert.throws(() => verifyMacSignature(bundle, { run: (_, args) => args.at(-1).endsWith('capri-windows')
    ? { status: 1, stderr: 'helper signature invalid' }
    : success(args.includes('--display') ? details : '') }), /helper signature invalid/);
});
