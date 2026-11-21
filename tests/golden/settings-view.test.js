'use strict';

// settingsView (settings-view.js) pinned for the default config before it moves to
// core/views/settings.js. Texts are pinned by identity with labels.js (the dictionaries are
// pinned by lang.test.js and settings.test.js): this golden holds the structure, the order,
// the controls, the keys they send, and which label goes where.

const test = require('node:test');
const assert = require('node:assert/strict');
const { settingsView } = require('../../src/main/settings-view');
const { DEFAULTS } = require('../../src/main/config');
const { TRAY, SETTINGS } = require('../../src/main/labels');

const t = TRAY.en;
const s = SETTINGS.en;
const autoLabel = t.auto(t.langNames.en);

const facts = () => ({
  cfg: { ...DEFAULTS, apiKeys: { openai: 'sk-never-leaves-main' } },
  lang: 'en', langSetting: 'auto', autoLang: 'en',
  assistant: { id: 'claude', name: 'Claude Code' },
  hooksInstalled: true,
  assistants: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'agy', name: 'Antigravity' }],
  provider: 'Ollama (local)',
  providers: [{ id: 'ollama', label: 'Ollama (local)', keyed: false }],
  model: 'llama3.2', models: ['llama3.2'],
  keys: {}, envKeys: {},
  features: { windowTracking: false, appList: false, appClose: false, appLaunch: true, mediaKeys: true, autostart: false, ollamaInstall: false, ollamaLaunch: true },
  autostart: false,
  screen: { index: 0, count: 1, width: 1920, height: 1080 },
  screens: [{ id: 7, width: 1920, height: 1080 }],
  renderNow: 'auto',
  about: { version: '0.4.3', platform: 'linux', arch: 'x64', electron: '44.9.3', session: 'wayland' },
});

const select = (key, value, options, extra = {}) => ({ type: 'select', key, value, options, ...extra });
const toggle = (key, value, extra = {}) => ({ type: 'toggle', key, value, ...extra });
const off = (reason) => ({ disabled: true, reason });

const EXPECTED = {
  lang: 'en',
  title: s.title, nav: s.nav, close: s.close, openMenu: s.openMenu,
  text: Object.fromEntries([
    'saved', 'saveFailed', 'invalid', 'moving', 'asks', 'keyPlaceholder', 'keySave', 'keySaved', 'keyEmpty', 'keyFormat',
    'keyRejected', 'keyEnv', 'urlSave', 'urlInvalid', 'reset', 'resetTitle', 'resetWhat', 'resetKeeps', 'resetConfirm',
    'cancel', 'resetDone', 'menuNote',
    ...Object.keys(s).filter((k) => k.startsWith('upd')),
  ].map((k) => [k, s[k]])),
  sections: [
    { id: 'general', title: s.general, fromMenu: true, rows: [
      { id: 'lang', label: t.lang, value: autoLabel, control: select('lang', 'auto', [
        { value: 'auto', label: autoLabel }, { value: 'fr', label: TRAY.fr.name }, { value: 'en', label: TRAY.en.name },
        { value: 'es', label: TRAY.es.name }, { value: 'pt', label: TRAY.pt.name }, { value: 'ru', label: TRAY.ru.name }]) },
      { id: 'autostart', label: t.startup, value: t.unavailable, control: toggle('autostart', false, off(t.unavailable)) },
      { id: 'scale', label: t.size, value: t.medium, control: select('scale', 0.6, [
        { value: 0.45, label: t.small }, { value: 0.6, label: t.medium }, { value: 0.8, label: t.large }]) },
      { id: 'muted', label: t.mute, value: s.off, control: toggle('muted', false) },
      { id: 'volume', label: s.volume, value: '70 %', control: { type: 'range', key: 'volume', value: 70, min: 0, max: 100, step: 5 } },
      { id: 'screen', label: t.screen, value: '1 / 1 — 1920×1080', control: select('displayId', 7, [{ value: 7, label: '1 — 1920×1080' }], off(s.oneScreen)) },
      { id: 'follow', label: t.follow, value: s.on, control: toggle('follow', true) },
      { id: 'render', label: t.display, value: t.displayAuto, control: select('render', 'auto', [
        { value: 'auto', label: t.displayAuto }, { value: 'gl', label: t.displayGl }, { value: 'software', label: t.displaySoftware }], { note: s.restartNote }) },
    ] },
    { id: 'behavior', title: s.behavior, fromMenu: false, rows: [
      { id: 'motion', label: t.motion, value: t.motionAuto, control: select('motion', 'auto', [
        { value: 'auto', label: t.motionAuto }, { value: 'full', label: t.motionFull }, { value: 'reduced', label: t.motionReduced }]) },
      { id: 'rest', label: t.rest, value: t.restCorner, control: select('rest', 'corner', [
        { value: 'corner', label: t.restCorner }, { value: 'taskbar', label: t.restTaskbar }]) },
      { id: 'initiative', label: t.initiative, value: t.initiativeNormal, control: select('initiative', 'normal', [
        { value: 'quiet', label: t.initiativeQuiet }, { value: 'normal', label: t.initiativeNormal }, { value: 'active', label: t.initiativeActive }], { note: s.initiativeNote }) },
      { id: 'wander', label: t.wander, value: s.on, control: toggle('wander', true) },
      { id: 'possess', label: t.possess, value: t.unavailable, control: toggle('possess', false, off(t.unavailable)) },
      { id: 'jealous', label: t.jealous, value: s.on, control: toggle('jealous', true) },
      { id: 'pcReact', label: t.pcReact, value: s.on, control: toggle('pcReact', true) },
      { id: 'watchScreen', label: t.lookAuto, value: s.off, control: toggle('watchScreen', false, { note: s.watchAsks }) },
    ] },
    { id: 'ai', title: s.ai, fromMenu: false, rows: [
      { id: 'assistant', label: t.watch, value: 'Claude Code', control: select('assistant', 'claude', [
        { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'agy', label: 'Antigravity' }, { value: 'none', label: t.watchNone }]) },
      { id: 'hooks', label: `${s.hooks} Claude Code`, value: s.on },
      { id: 'provider', label: s.provider, value: 'Ollama (local)', control: select('provider', 'ollama', [{ value: 'ollama', label: 'Ollama (local)' }]) },
      { id: 'model', label: s.model, value: 'llama3.2', control: select('chatModel', 'llama3.2', [{ value: 'llama3.2', label: 'llama3.2' }]) },
    ] },
    { id: 'about', title: s.about, fromMenu: false, rows: [
      { id: 'version', label: s.version, value: '0.4.3' },
      { id: 'system', label: s.system, value: 'Linux · x64 · wayland' },
      { id: 'electron', label: s.electron, value: '44.9.3' },
      { id: 'license', label: s.license, value: 'PolyForm Noncommercial 1.0.0' },
    ] },
  ],
};

test('settingsView: the default config, whole view (golden)', () => {
  assert.deepEqual(settingsView(facts()), EXPECTED);
});

test('settingsView: no secret in the view, and it crosses IPC as it is', () => {
  const view = settingsView(facts());
  const json = JSON.stringify(view);
  assert.equal(json.includes('sk-never-leaves-main'), false);
  assert.equal(json.includes('apiKeys'), false);
  assert.deepEqual(structuredClone(view), view);
});