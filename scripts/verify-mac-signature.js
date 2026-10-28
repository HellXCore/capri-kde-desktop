'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function verifyMacSignature(bundle, { run = spawnSync } = {}) {
  const codesign = (args) => {
    const result = run('/usr/bin/codesign', args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`macOS signature verification failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
    }
    return `${result.stdout || ''}\n${result.stderr || ''}`;
  };
  codesign(['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  const details = codesign(['--display', '--verbose=4', bundle]);
  if (!/^Identifier=capri\.desktop\r?$/m.test(details) || !/^Sealed Resources version=\d+/m.test(details)) {
    throw new Error('macOS signature verification failed: expected capri.desktop with sealed bundle resources');
  }
  codesign(['--verify', '--strict', '--verbose=2', path.join(bundle, 'Contents', 'Resources', 'bin', 'capri-windows')]);
  console.log(`[capri] verified sealed macOS bundle: ${bundle}`);
}

if (require.main === module) {
  if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Usage on macOS: node scripts/verify-mac-signature.js /path/to/Capri.app');
  verifyMacSignature(path.resolve(process.argv[2]));
}
module.exports = { verifyMacSignature };
