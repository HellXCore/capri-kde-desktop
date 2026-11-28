'use strict';

// The wishes themselves, without a transport: what is recorded, that the caller's objects are
// copied, and the order they are said again in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesiredState } = require('../src/main/platform/shell/state');
const { ENV, DISPLAY } = require('./fakes/agent-messages');

const make = () => {
  const said = [];
  const wish = createDesiredState({ env: ENV });
  return { wish, said, send: (type, payload) => said.push([type, payload]) };
};

test('hello names the facts and who we are, even before anything was asked for', () => {
  const m = make();
  m.wish.hello(m.send);
  assert.deepEqual(m.said, [['hello', { env: ENV, displays: [], overlay: { pid: 0, title: '', xid: null } }]]);
});

test('nothing asked for: the replay only says who holds the keyboard', () => {
  const m = make();
  m.wish.replay(m.send);
  assert.deepEqual(m.said, [['overlay.focus', { on: false }]]);
});

test('the replay order: displays, place, zones, keyboard, shortcuts', () => {
  const m = make();
  const rect = { x: 1, y: 2, w: 3, h: 4 };
  m.wish.setIdentity({ pid: 7, title: 'capri-overlay', xid: 0x4400002 });
  m.wish.setDisplays([DISPLAY]);
  m.wish.setWant(rect);
  m.wish.setZones({ rects: [rect], dpr: 2 });
  m.wish.setFocus(true);
  m.wish.setHotkey('stow', 'Ctrl+Alt+C');
  m.wish.hello(m.send);
  m.wish.replay(m.send);
  assert.deepEqual(m.said.map(([type]) => type),
    ['hello', 'displays', 'overlay.want', 'overlay.zones', 'overlay.focus', 'hotkey.set']);
  assert.deepEqual(m.said[0][1].overlay, { pid: 7, title: 'capri-overlay', xid: 0x4400002 });
  const before = m.said.length;
  m.wish.replay(m.send);
  assert.deepEqual(m.said.slice(before), m.said.slice(1, before)); // repeatable, the same words
});

test('what is recorded is a copy: changing it afterwards changes nothing', () => {
  const m = make();
  const rect = { x: 1, y: 2, w: 3, h: 4 };
  const list = [DISPLAY];
  m.wish.setWant(rect);
  m.wish.setDisplays(list);
  m.wish.setZones({ rects: [rect], dpr: 1 });
  rect.x = 99;
  list.length = 0;
  m.wish.replay(m.send);
  assert.deepEqual(m.said[0], ['displays', { list: [DISPLAY] }]);
  assert.deepEqual(m.said[1], ['overlay.want', { rect: { x: 1, y: 2, w: 3, h: 4 } }]);
  assert.deepEqual(m.said[2][1].rects, [{ x: 1, y: 2, w: 3, h: 4 }]);
});

test('a hotkey id is one wish: the last accelerator wins', () => {
  const m = make();
  m.wish.setHotkey('stow', 'Ctrl+Alt+C');
  m.wish.setHotkey('stow', 'Ctrl+Alt+D');
  m.wish.replay(m.send);
  assert.deepEqual(m.said, [['overlay.focus', { on: false }], ['hotkey.set', { id: 'stow', accel: 'Ctrl+Alt+D' }]]);
});
