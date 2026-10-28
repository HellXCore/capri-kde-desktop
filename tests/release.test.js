'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseFiles, draftPayload } = require('../scripts/draft-release');

test('release requires a non-empty installer for every platform and architecture', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ['win-x64.exe', 'linux-x86_64.AppImage', 'linux-amd64.deb', 'mac-arm64.dmg', 'mac-arm64.zip'].map((suffix) => `Capri-0.1.0-${suffix}`);
  for (const name of names.slice(0, -1)) fs.writeFileSync(path.join(dir, name), 'installer');
  assert.throws(() => releaseFiles(dir, '0.1.0'), /Missing installer.*mac-arm64.zip/);
  fs.writeFileSync(path.join(dir, names.at(-1)), '');
  assert.throws(() => releaseFiles(dir, '0.1.0'), /Empty installer/);
  fs.writeFileSync(path.join(dir, names.at(-1)), 'installer');
  assert.deepEqual(releaseFiles(dir, '0.1.0'), names);
});

test('release remains a draft, targets the built commit, and never replaces a published version', () => {
  const sha = 'a'.repeat(40);
  assert.equal(draftPayload(null, '0.1.0', sha).draft, true);
  assert.equal(draftPayload({ draft: true }, '0.1.0', sha).target_commitish, sha);
  assert.equal(draftPayload(null, '0.1.0', sha).tag_name, 'fork-v0.1.0');
  assert.throws(() => draftPayload({ draft: false }, '0.1.0', sha), /already published/);
  assert.throws(() => draftPayload(null, 'bad version', sha), /x.y.z/);
});
