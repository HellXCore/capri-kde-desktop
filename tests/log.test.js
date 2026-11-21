'use strict';

// createLogger (core/log.js): the scope on every line, the four levels to the sink's own methods,
// a missing or blank scope refused, console as the default sink.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/main/core/log');

function recorder() {
  const lines = [];
  const sink = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    sink[level] = (msg) => lines.push([level, msg]);
  }
  return { sink, lines };
}

test('logger: every level writes through the sink, stamped with the scope', () => {
  const { sink, lines } = recorder();
  const log = createLogger({ scope: 'agent', sink });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(lines, [
    ['debug', '[agent] d'],
    ['info', '[agent] i'],
    ['warn', '[agent] w'],
    ['error', '[agent] e'],
  ]);
});

test('logger: the message passes through as it is', () => {
  const { sink, lines } = recorder();
  createLogger({ scope: 'agent', sink }).info('a  b\nc');
  assert.deepEqual(lines, [['info', '[agent] a  b\nc']]);
});

test('logger: a scope is required', () => {
  for (const scope of [undefined, null, '', '   ', 42]) {
    assert.throws(() => createLogger({ scope, sink: recorder().sink }), /scope/);
  }
  assert.throws(() => createLogger({}), /scope/);
});

test('logger: two scopes stay apart; nothing is written until a line is logged', () => {
  const { sink, lines } = recorder();
  const a = createLogger({ scope: 'agent', sink });
  const b = createLogger({ scope: 'shell', sink });
  assert.deepEqual(lines, []);
  a.info('up');
  b.warn('down');
  assert.deepEqual(lines, [['info', '[agent] up'], ['warn', '[shell] down']]);
});

test('logger: console is the default sink', (t) => {
  const said = [];
  t.mock.method(console, 'info', (msg) => said.push(msg));
  createLogger({ scope: 'agent' }).info('hello');
  assert.deepEqual(said, ['[agent] hello']);
});