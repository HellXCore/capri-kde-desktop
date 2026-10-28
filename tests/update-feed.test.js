'use strict';
// How electron-updater's GitHub provider reads this fork's releases (docs/UPDATES.md): the release
// GitHub marks "latest" decides, its tag is taken as it is (fork-vX.Y.Z), and the version comes from
// latest*.yml, not from the tag. The inherited upstream tags (v0.1.0 … v0.4.4) never enter into it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { HttpError } = require(require.resolve('builder-util-runtime', { paths: [require.resolve('electron-updater')] })); // electron-updater's own copy

const BASE = 'https://github.com/Libes6/capri-desktop/releases';
const feed = (tags) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `
  <entry><title>${tag}</title><link rel="alternate" type="text/html" href="${BASE}/tag/${tag}"/><content type="html">&lt;p&gt;Notes of ${tag}&lt;/p&gt;</content></entry>`).join('')}
</feed>`;
const yml = (version) => `version: ${version}
files:
  - url: Capri-${version}-mac-arm64.zip
    sha512: c2hhNTEy
    size: 1234
  - url: Capri-${version}-mac-arm64.dmg
    sha512: ZG1n
    size: 2345
path: Capri-${version}-mac-arm64.zip
sha512: c2hhNTEy
releaseDate: '2026-10-28T00:00:00.000Z'
`;

function provider(routes, requested) {
  const executor = {
    request: async (options) => {
      const url = `${options.protocol || 'https:'}//${options.hostname}${options.path}`;
      requested.push(url);
      if (!(url in routes)) throw new HttpError(404, `Not Found ${url}`);
      return routes[url];
    },
  };
  const updater = { allowPrerelease: false, channel: null, currentVersion: { version: '0.1.0' }, fullChangelog: false };
  return new GitHubProvider({ provider: 'github', owner: 'Libes6', repo: 'capri-desktop' }, updater, { executor, platform: 'darwin', isUseMultipleRangeRequest: false });
}

test('fork-vX.Y.Z tags: the latest release\'s tag is used verbatim, the version comes from latest-mac.yml', async () => {
  const requested = [];
  const p = provider({
    [`${BASE}.atom`]: feed(['fork-v0.2.0', 'fork-v0.1.0']),
    [`${BASE}/latest`]: JSON.stringify({ tag_name: 'fork-v0.2.0' }),
    [`${BASE}/download/fork-v0.2.0/latest-mac.yml`]: yml('0.2.0'),
  }, requested);
  const info = await p.getLatestVersion();
  assert.equal(info.version, '0.2.0');
  assert.equal(info.tag, 'fork-v0.2.0');
  assert.match(info.releaseNotes, /Notes of fork-v0.2.0/);
  const files = p.resolveFiles(info);
  assert.equal(files[0].url.href, `${BASE}/download/fork-v0.2.0/Capri-0.2.0-mac-arm64.zip`);
  assert.equal(files[0].info.size, 1234);
  assert.ok(requested.includes(`${BASE}/download/fork-v0.2.0/latest-mac.yml`));
});

test('a published release without latest*.yml (fork-v0.1.0) is a feed error, never "no update"', async () => {
  const p = provider({
    [`${BASE}.atom`]: feed(['fork-v0.1.0']),
    [`${BASE}/latest`]: JSON.stringify({ tag_name: 'fork-v0.1.0' }),
  }, []);
  await assert.rejects(p.getLatestVersion(), (err) => err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
});

test('no published release at all is reported as such', async () => {
  const p = provider({ [`${BASE}.atom`]: feed([]) }, []);
  await assert.rejects(p.getLatestVersion(), (err) => /No published versions|ERR_UPDATER/.test(`${err.code} ${err.message}`));
});
