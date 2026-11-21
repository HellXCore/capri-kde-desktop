'use strict';

// A logger that stamps every line with its scope. The scope is mandatory: several components
// share one sink, and an unscoped line cannot be told apart. The sink is anything with the four
// level methods (console by default), so a test records lines instead of printing them.

/**
 * @param {{ scope: string, sink?: import('./ports').LogSink }} o
 * @returns {import('./ports').Logger}
 */
function createLogger({ scope, sink = console }) {
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new Error('createLogger: a scope is required');
  }
  const tag = `[${scope}]`;
  /** @param {'debug'|'info'|'warn'|'error'} level */
  const write = (level) => (/** @type {string} */ msg) => { sink[level](`${tag} ${msg}`); };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

module.exports = { createLogger };