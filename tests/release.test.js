'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { releaseFiles, draftPayload, parseUpdateInfo } = require('../scripts/draft-release');

const INSTALLERS = ['linux-x86_64.AppImage', 'linux-amd64.deb'].map((suffix) => `Capri-0.1.0-${suffix}`);
const UPDATES = ['latest-linux.yml'];
const sha512 = (dir, name) => createHash('sha512').update(fs.readFileSync(path.join(dir, name))).digest('base64');

// update info as electron-builder writes it
function feed(dir, version, names, { sha = (name) => sha512(dir, name) } = {}) {
  const entries = names.map((name) => `  - url: ${name}\n    sha512: ${sha(name)}\n    size: ${fs.statSync(path.join(dir, name)).size}\n`).join('');
  return `version: ${version}\nfiles:\n${entries}path: ${names[0]}\nsha512: ${sha(names[0])}\nreleaseDate: '2026-10-28T00:00:00.000Z'\n`;
}

function release(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of INSTALLERS) fs.writeFileSync(path.join(dir, name), `installer ${name}`);
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), feed(dir, '0.1.0', [INSTALLERS[0], INSTALLERS[1]]));
  return dir;
}

test('release carries the update files: latest*.yml for each platform and the blockmaps', (t) => {
  const dir = release(t);
  assert.deepEqual(releaseFiles(dir, '0.1.0'), [...INSTALLERS, ...UPDATES]);
  for (const name of UPDATES) {
    const moved = path.join(dir, `${name}.away`);
    fs.renameSync(path.join(dir, name), moved);
    assert.throws(() => releaseFiles(dir, '0.1.0'), new RegExp(`Missing update file: ${name.replace(/\./g, '\\.')}`));
    fs.renameSync(moved, path.join(dir, name));
  }
});

test('each latest*.yml names this version and exactly the release assets, with their sha512 and size', (t) => {
  const dir = release(t);
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), feed(dir, '0.1.0', [INSTALLERS[1]]));
  assert.throws(() => releaseFiles(dir, '0.1.0'), /latest-linux.yml has no .AppImage/);
});

test('update info is read as electron-builder writes it', () => {
  const info = parseUpdateInfo("version: 0.2.0\nfiles:\n  - url: A.zip\n    sha512: abc==\n    size: 12\n    blockMapSize: 3\n  - url: A.dmg\n    sha512: def\n    size: 34\npath: A.zip\nsha512: abc==\nreleaseDate: '2026-10-28T00:00:00.000Z'\n");
  assert.deepEqual(info, { version: '0.2.0', files: [{ url: 'A.zip', sha512: 'abc==', size: 12 }, { url: 'A.dmg', sha512: 'def', size: 34 }] });
});

test('release remains a draft, targets the built commit, and never replaces a published version', () => {
  const sha = 'a'.repeat(40);
  assert.equal(draftPayload(null, '0.1.0', sha).draft, true);
  assert.equal(draftPayload({ draft: true }, '0.1.0', sha).target_commitish, sha);
  assert.equal(draftPayload(null, '0.1.0', sha).tag_name, 'fork-v0.1.0');
  assert.throws(() => draftPayload({ draft: false }, '0.1.0', sha), /already published/);
  assert.throws(() => draftPayload(null, 'bad version', sha), /x.y.z/);
});
