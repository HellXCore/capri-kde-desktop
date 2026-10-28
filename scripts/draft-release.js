'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function releaseFiles(dir, version) {
  const expected = [
    `Capri-${version}-win-x64.exe`,
    `Capri-${version}-linux-x86_64.AppImage`,
    `Capri-${version}-linux-amd64.deb`,
    `Capri-${version}-mac-arm64.dmg`,
    `Capri-${version}-mac-arm64.zip`,
  ];
  for (const name of expected) {
    if (!fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing installer: ${name}`);
    if (!fs.statSync(path.join(dir, name)).size) throw new Error(`Empty installer: ${name}`);
  }
  return expected;
}

function draftPayload(existing, version, sha) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a stable x.y.z package version');
  if (existing && !existing.draft) throw new Error(`fork-v${version} is already published; bump package.json and package-lock.json`);
  return {
    tag_name: `fork-v${version}`, target_commitish: sha, name: `Capri v${version}`, draft: true,
    body: `Cross-platform build from ${sha}.\n\nWindows x64: EXE\nLinux x64 (X11/XWayland): AppImage and DEB\nmacOS Apple Silicon: DMG and ZIP\n\nUnsigned builds: Windows signing and Apple Developer ID/notarization are not configured.\nWindow tracking and desktop automation remain Windows-only in v0.1.\n\nVerify SHA256SUMS.txt and test installers before publishing.`,
  };
}

function main() {
  const version = require('../package.json').version;
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  if (!repo || !sha) throw new Error('Run this script in GitHub Actions with GITHUB_REPOSITORY and GITHUB_SHA');
  const dir = path.resolve(process.argv[2] || 'release-assets');
  const names = releaseFiles(dir, version);
  const checksums = names.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), checksums);
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 10 * 1024 * 1024 });
  // Drafts are included for the authenticated repository token; tags/ endpoints don't find untagged drafts.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  const existing = pages.flat().find((release) => release.tag_name === `fork-v${version}`);
  const payload = draftPayload(existing, version, sha);
  // Refuse to attach a new commit's binaries to an existing tag pointing elsewhere.
  const refs = JSON.parse(gh(['api', `repos/${repo}/git/matching-refs/tags/fork-v${version}`]));
  if (refs.some((ref) => ref.ref === `refs/tags/fork-v${version}` && (ref.object.type !== 'commit' || ref.object.sha !== sha))) {
    throw new Error(`Tag fork-v${version} already exists at another commit; bump the version`);
  }
  const endpoint = existing ? `repos/${repo}/releases/${existing.id}` : `repos/${repo}/releases`;
  const release = JSON.parse(gh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], JSON.stringify(payload)));
  // Use the release id: gh release upload resolves tags, which may not exist for a draft yet.
  const assets = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases/${release.id}/assets?per_page=100`])).flat();
  for (const name of [...names, 'SHA256SUMS.txt']) {
    const old = assets.find((asset) => asset.name === name);
    if (old) gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${old.id}`]);
    gh(['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream',
      `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, '--input', path.join(dir, name)]);
  }
  console.log(`Draft ready: ${release.html_url}`);
}

if (require.main === module) main();
module.exports = { releaseFiles, draftPayload };
