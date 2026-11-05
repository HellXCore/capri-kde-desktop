'use strict';

// How electron-updater's GitHub provider reads this Linux releases:
// the release GitHub marks "latest" decides, its tag is taken as it is (vX.Y.Z),
// and the version comes from latest-linux.yml, not from the tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { HttpError } = require(require.resolve('builder-util-runtime', { paths: [require.resolve('electron-updater')] })); // electron-updater's own copy

const OWNER = 'HellXCore';
const REPO = 'capri-desktop';
const BASE = `https://github.com/${OWNER}/${REPO}/releases`;

const feed = (tags) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `
  <entry><title>${tag}</title><link rel="alternate" type="text/html" href="${BASE}/tag/${tag}"/><content type="html">&lt;p&gt;Notes of ${tag}&lt;/p&gt;</content></entry>`).join('')}
</feed>`;

const yml = (version) => `version: ${version}
files:
  - url: Capri-${version}.AppImage
    sha512: c2hhNTEy
    size: 1234
path: Capri-${version}.AppImage
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
  return new GitHubProvider(
    { provider: 'github', owner: OWNER, repo: REPO },
    updater,
    { executor, platform: 'linux', isUseMultipleRangeRequest: false }
  );
}

test('Linux AppImage: tag is used verbatim, version comes from latest-linux.yml', async () => {
  const requested = [];
  const p = provider({
    [`${BASE}.atom`]: feed(['v0.2.0', 'v0.1.0']),
    [`${BASE}/latest`]: JSON.stringify({ tag_name: 'v0.2.0' }),
    [`${BASE}/download/v0.2.0/latest-linux.yml`]: yml('0.2.0'),
  }, requested);

  const info = await p.getLatestVersion();
  assert.equal(info.version, '0.2.0');
  assert.equal(info.tag, 'v0.2.0');
  assert.match(info.releaseNotes, /Notes of v0.2.0/);

  const files = p.resolveFiles(info);
  assert.equal(files[0].url.href, `${BASE}/download/v0.2.0/Capri-0.2.0.AppImage`);
  assert.equal(files[0].info.size, 1234);
  assert.ok(requested.includes(`${BASE}/download/v0.2.0/latest-linux.yml`));
});

test('a published release without latest-linux.yml is a feed error, never "no update"', async () => {
  const p = provider({
    [`${BASE}.atom`]: feed(['v0.1.0']),
    [`${BASE}/latest`]: JSON.stringify({ tag_name: 'v0.1.0' }),
  }, []);
  await assert.rejects(p.getLatestVersion(), (err) => err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
});

test('no published release at all is reported as such', async () => {
  const p = provider({ [`${BASE}.atom`]: feed([]) }, []);
  await assert.rejects(p.getLatestVersion(), (err) => /No published versions|ERR_UPDATER/.test(`${err.code} ${err.message}`));
});
