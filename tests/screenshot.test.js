'use strict';

// The screenshot stack: the order comes from outside, the dispatcher only runs it. A method that
// is not there falls through to the next one; nothing here may pick a tool by the desktop's name.

const test = require('node:test');
const assert = require('node:assert/strict');
const { grab, BASE_METHODS } = require('../src/main/linux/screenshot');

const image = (empty = false) => ({ isEmpty: () => empty });
const nativeImage = (empty = false) => ({ createFromPath: () => image(empty) });
const noCapturer = { getSources: async () => { throw new Error('desktopCapturer must not be reached here'); } };
const gone = (calls) => async (cmd) => { calls.push(cmd); throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); };

test('the base stack is what the display server can do on its own', () => {
  assert.deepEqual(BASE_METHODS, { wayland: ['portal'], xwayland: ['capturer'], x11: ['capturer'], none: [] });
});

test('the stack is run in order, and the first picture wins', async () => {
  const calls = [];
  const shot = await grab({
    methods: ['spectacle', 'portal'], multi: true,
    exec: async (cmd, args) => { calls.push([cmd, args]); },
    nativeImage: nativeImage(), capturer: noCapturer,
  });
  assert.deepEqual(calls.map(([cmd]) => cmd), ['spectacle']);
  assert.ok(calls[0][1].includes('-m')); // one screen of several
  assert.equal(shot.isEmpty(), false);
});

test('a tool that is not installed falls through; all of them failing is null', async () => {
  const calls = [];
  assert.equal(await grab({ methods: ['spectacle', 'portal'], exec: gone(calls), nativeImage: nativeImage(), capturer: noCapturer }), null);
  assert.deepEqual(calls, ['spectacle', 'python3']);
  assert.equal(await grab({ methods: [], exec: gone(calls), nativeImage: nativeImage(), capturer: noCapturer }), null);
});

test('an empty picture is not a picture: the next method is tried', async () => {
  const calls = [];
  await grab({ methods: ['spectacle', 'portal'], exec: async (cmd) => { calls.push(cmd); }, nativeImage: nativeImage(true), capturer: noCapturer });
  assert.deepEqual(calls, ['spectacle', 'python3']);
});

test('a Wayland desktop with no adapter never runs KDE\'s tool', async () => {
  const calls = [];
  await grab({ methods: BASE_METHODS.wayland, exec: gone(calls), nativeImage: nativeImage(), capturer: noCapturer });
  assert.deepEqual(calls, ['python3']);
});

test('capturer takes the screen it was given, at that screen\'s own pixels', async () => {
  const asked = [];
  const thumbnail = image();
  const capturer = { getSources: async (q) => { asked.push(q); return [{ display_id: '9', thumbnail: image(true) }, { display_id: '7', thumbnail }]; } };
  const shot = await grab({
    methods: ['capturer'], display: { id: 7, bounds: { width: 1920, height: 1080 }, scaleFactor: 2 },
    capturer, nativeImage: nativeImage(), exec: async () => { throw new Error('capturer runs no tool'); },
  });
  assert.equal(shot, thumbnail);
  assert.deepEqual(asked, [{ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } }]);
});

test('capturer with nothing to show is a failure, not a black picture', async () => {
  const capturer = { getSources: async () => [{ display_id: '7', thumbnail: image(true) }] };
  assert.equal(await grab({
    methods: ['capturer'], display: { id: 7, bounds: { width: 800, height: 600 } },
    capturer, nativeImage: nativeImage(), exec: async () => {},
  }), null);
});