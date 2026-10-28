'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Her chat goes by main's capabilities (forRenderer): what isn't there is neither offered to her model
// nor run, and never reported done.
const load = async () => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} }); // util.js reads it on import
  const url = (file) => pathToFileURL(path.resolve(__dirname, '../src/renderer/js', file)).href;
  const [{ Chat }, { linesFor }] = await Promise.all([import(url('chat.js')), import(url('lines.js'))]);
  return { Chat, linesFor };
};

const WINDOWS = { windows: true, possess: true, closeApps: true, launchApps: true, mediaKeys: true, ollamaLaunch: true };
const NONE = { windows: false, possess: false, closeApps: false, launchApps: false, mediaKeys: false, ollamaLaunch: false };

async function chatWith(caps) {
  const { Chat, linesFor } = await load();
  const calls = [];
  const said = [];
  const faces = [];
  const host = {
    onChatDelta() {},
    findApp: async (name) => (calls.push(['findApp', name]), { name, label: name }),
    closeApp: async (name) => (calls.push(['closeApp', name]), { unsupported: true }),
    media: async (action) => (calls.push(['media', action]), true),
    listApps: async () => [],
    chatRemember() {},
  };
  const panel = { stream: (line) => said.push(line), setFace: (f) => faces.push(f), setActions() {} };
  const capri = { pulse() {}, zap() {}, head: () => ({ x: 0, y: 0 }), towardCenter: () => 1 };
  const brain = { caps, lang: 'en', t: linesFor('en') };
  const chat = new Chat({ capri, panel, voice: {}, host, brain });
  chat.open = true;
  chat.listApps = () => {};
  return { chat, calls, said, faces, t: brain.t.chat };
}

test('chat powers: Windows offers apps and media keys, nothing said to be missing', async () => {
  const { chat } = await chatWith(WINDOWS);
  const powers = chat.powers().join('\n');
  assert.match(powers, /\[\[media: ACTION\]\]/);
  assert.match(powers, /an app, a game/);
  assert.doesNotMatch(powers, /On this computer you can't/);
});

test('chat powers: elsewhere no media tag, no apps, and what she can\'t do is said plainly', async () => {
  for (const caps of [NONE, undefined]) {
    const { chat } = await chatWith(caps);
    const powers = chat.powers().join('\n');
    assert.doesNotMatch(powers, /\[\[media:/);
    assert.doesNotMatch(powers, /an app, a game/);
    assert.match(powers, /On this computer you can't open installed apps or games, control the music playing \(pause, next, volume\), close apps/);
  }
});

test('chat: media keys and closing apps never reach main where they are not supported', async () => {
  const { chat, calls, said, faces, t } = await chatWith(NONE);
  await chat.media('pause', '…');
  await chat.offerClose('Discord', 'OK.');
  assert.deepEqual(calls, []);
  assert.deepEqual(said, [t.cantMedia, `OK.\n${t.cantClose.replace('{app}', 'Discord')}`]);
  assert.deepEqual(faces, ['aside', 'aside']);
});

test('chat: an unsupported close from main is not reported as closed', async () => {
  const { chat, said, faces, t } = await chatWith(WINDOWS);
  await chat.closeApp({ name: 'Discord' });
  assert.deepEqual(said, [t.cantClose.replace('{app}', 'Discord')]);
  assert.notEqual(said[0], t.closed.replace('{app}', 'Discord'));
  assert.deepEqual(faces, ['aside']);
});
