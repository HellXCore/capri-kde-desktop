'use strict';

// Finding your files when you ask her ("trouve mon CV", "where's my report"). KDE Baloo search
// index first: your whole user folder, by name and by what's in the files, in a blink. If it's off,
// a walk through your usual folders, by name. Then a screenshot when you ask for one.

const fs = require('node:fs');
const path = require('node:path');
const { app, shell, screen } = require('electron');

const LIMIT = 8;
const found = new Set(); // what a search showed you: the only paths she opens from here

const words = (query) => String(query || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^\p{L}\p{N}.]+/u).filter((w) => w.length >= 2).slice(0, 5);

// never in the results: code dependencies, app data, git internals, the trash
const JUNK = new Set(['node_modules', '.git', 'site-packages', '.cache', 'Trash']);
const junk = (p) => p.split(path.sep).some((seg) => JUNK.has(seg));

// Search redirected to baloo
async function indexed(terms, exts) {
  return require('./linux/baloo').search(terms, exts, { home: app.getPath('home'), limit: LIMIT * 3 });
}

// The walk, when the index isn't there: your usual folders, a few levels down, by name and type.
async function walked(terms, exts) {
  const roots = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'].map((k) => app.getPath(k));
  const hits = [];
  const queue = roots.map((dir) => [dir, 0]);
  let seen = 0;
  while (queue.length && hits.length < LIMIT * 3 && seen < 40000) {
    const [dir, depth] = queue.shift();
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      const name = words(e.name).join(' ');
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (terms.every((t) => name.includes(t)) && (!exts.length || exts.includes(ext))) hits.push(full);
      if (e.isDirectory() && depth < 5) queue.push([full, depth + 1]);
    }
  }
  return hits;
}

// [{ path, name, folder }], the newest first, at most LIMIT. `query`: words of the name; `exts`:
// the kinds of file it is (["aep"] for an After Effects project), when that's what was asked.
async function search({ query = '', exts = [] } = {}) {
  const terms = words(query);
  if (!terms.length && !exts.length) return [];
  const paths = await indexed(terms, exts);
  const results = listed(paths?.length ? paths : await walked(terms, exts));
  return results.length || !paths?.length ? results : listed(await walked(terms, exts));
}

function listed(paths) {
  const results = paths.filter((p) => !junk(p)).slice(0, LIMIT).map((p) => {
    let time = 0;
    try {
      time = fs.statSync(p).mtimeMs;
    } catch {
      return null; // gone since
    }
    return { path: p, name: path.basename(p), folder: path.basename(path.dirname(p)), time };
  }).filter(Boolean);
  for (const r of results) found.add(r.path);
  return results;
}

// one of the files she found: opened, or shown in its folder
async function open(file, { reveal = false } = {}) {
  if (!found.has(file)) throw new Error('not one she found');
  if (reveal) {
    shell.showItemInFolder(file);
    return;
  }
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
}

// `methods`: the stack the wiring put together (the adapter's own first, then this server's).
async function screenshot(display, { methods = [] } = {}) {
  const d = display || screen.getPrimaryDisplay();
  const shot = await require('./linux/screenshot').grab({
    methods, multi: screen.getAllDisplays().length > 1, display: d,
  });
  if (!shot) throw new Error('no picture of the screen');
  const png = shot.toPNG();
  const dir = path.join(app.getPath('pictures'), 'Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const file = path.join(dir, `Capri ${stamp}.png`);
  fs.writeFileSync(file, png);
  found.add(file);
  return { path: file, name: path.basename(file) };
}

module.exports = { search, open, screenshot };
