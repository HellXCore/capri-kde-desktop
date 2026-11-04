'use strict';

// Finding files with KDE's Baloo index (baloosearch6, or baloosearch on Plasma 5): by name first, then
// by what is in documents. Resolves with a list of paths, or null where Baloo is not there or is off.

const path = require('node:path');
const { execFile } = require('node:child_process');

const BINS = ['baloosearch6', 'baloosearch'];
// Code, left out of a search by what is inside (any word shows up in some library)
const CODE = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'map', 'lock', 'yml', 'yaml', 'py', 'css', 'html', 'md', 'txt', 'xml', 'log']);

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
});

// Its output is one path a line, and some words of its own ("Elapsed: ...") that are no path
const pathsIn = (out) => String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/'));

async function search(terms, exts, { home, limit = 24, exec = run } = {}) {
  const safe = terms.map((t) => t.replace(/[^\p{L}\p{N}.]/gu, '')).filter(Boolean);
  if (!safe.length) return null; // only a kind of file asked for: the walk does that
  const wanted = new Set(exts.map((e) => e.toLowerCase()));
  const ofKind = (p) => !wanted.size || wanted.has(path.extname(p).slice(1).toLowerCase());
  const ask = async (words) => {
    let lastError = null;
    for (const bin of BINS) {
      try {
        return pathsIn(await exec(bin, ['-d', home, '-l', String(limit), ...words]));
      } catch (err) {
        lastError = err;
        if (err.code !== 'ENOENT') break; // it is there and failed: Baloo is off
      }
    }
    throw lastError;
  };
  try {
    const found = (await ask(safe.map((t) => `filename:${t}`))).filter(ofKind);
    if (found.length >= 8 || wanted.size) return [...new Set(found)];
    const inside = (await ask(safe)).filter((p) => !CODE.has(path.extname(p).slice(1).toLowerCase()));
    return [...new Set([...found, ...inside])];
  } catch {
    return null;
  }
}

module.exports = { search, pathsIn };
