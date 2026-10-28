'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyMacSignature } = require('./verify-mac-signature');

if (process.platform !== 'darwin') throw new Error('Verify macOS artifacts on macOS');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const dist = path.resolve(process.argv[2] || path.join(root, 'dist'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-signature-'));
const unpack = path.join(temp, 'zip');
const mount = path.join(temp, 'dmg');
let mounted = false;
try {
  fs.mkdirSync(unpack);
  fs.mkdirSync(mount);
  execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(dist, `Capri-${version}-mac-arm64.zip`), unpack], { stdio: 'inherit' });
  const app = path.join(unpack, 'Capri.app');
  verifyMacSignature(app);
  execFileSync(process.execPath, [path.join(root, 'scripts/smoke-test.js'), path.join(app, 'Contents/MacOS/Capri'), '--expect-window-tracking'], { stdio: 'inherit', timeout: 60000 });
  execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(dist, `Capri-${version}-mac-arm64.dmg`)], { stdio: 'inherit' });
  mounted = true;
  verifyMacSignature(path.join(mount, 'Capri.app'));
  // Reject the same class of resource-integrity failure as 0.2.0, without modifying release files.
  fs.appendFileSync(path.join(app, 'Contents/Resources/app.asar'), '\nmodified resource');
  let rejected = false;
  try { verifyMacSignature(app); } catch { rejected = true; }
  if (!rejected) throw new Error('Signature verifier accepted a modified app.asar');
  console.log('[capri] ZIP and DMG signatures valid; ZIP starts; modified resources rejected');
} finally {
  // Never remove a mounted filesystem recursively if detach fails.
  if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'inherit' });
  fs.rmSync(temp, { recursive: true, force: true });
}
