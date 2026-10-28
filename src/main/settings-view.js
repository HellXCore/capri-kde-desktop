'use strict';

// What her settings window shows, built from the config and what main knows. Pure (no Electron):
// main.js gathers the facts, this turns them into sections of labelled rows in her language.
// For now every row is read-only (the settings themselves still live in her menu); CAPRI-04 gives
// rows a control, keyed by the same `id`.

const { TRAY, SETTINGS, LANGS } = require('./labels');

const SECTIONS = ['general', 'behavior', 'ai', 'about'];
const OS_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function sizeLabel(t, scale) {
  const named = [[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].find(([, s]) => Math.abs(scale - s) < 0.01);
  return named ? named[0] : `${Math.round((Number(scale) || 0) * 100)} %`;
}

function pick(pairs, value, fallback) {
  return (pairs.find(([v]) => v === value) || [null, fallback])[1];
}

/**
 * @param {object} facts
 *   cfg: the config (keys are not needed and not read)
 *   lang: the language she speaks now; langSetting: 'auto' or a language; autoLang: what 'auto' gives
 *   assistant: { id, name } she watches, or null when she watches none; hooksInstalled: its hooks are in
 *   provider: the label of who answers her chat; model: the model picked (null: none reached)
 *   features: capabilities.all(); autostart: whether she starts with the system right now
 *   screen: { index, count, width, height } of the screen she's on
 *   about: { version, platform, arch, electron, session }
 */
function settingsView(facts) {
  const { cfg = {}, features = {}, about = {} } = facts;
  const lang = LANGS.includes(facts.lang) ? facts.lang : 'en';
  const s = SETTINGS[lang];
  const watched = facts.assistant;
  // the menu's labels, with Claude Code swapped for the assistant she watches, as the menu does
  const t = Object.fromEntries(Object.entries(TRAY[lang]).map(([key, value]) =>
    [key, typeof value === 'string' && watched && watched.id !== 'claude' ? value.replaceAll('Claude Code', watched.name) : value]));
  const onOff = (value) => (value ? s.on : s.off);
  const unavailable = (feature, value) => (features[feature] ? value : t.unavailable);

  const langValue = facts.langSetting === 'auto' || !LANGS.includes(facts.langSetting)
    ? t.auto(t.langNames[facts.autoLang] || facts.autoLang || '')
    : TRAY[facts.langSetting].name;
  const sc = facts.screen;

  const rows = {
    general: [
      { id: 'lang', label: t.lang, value: langValue },
      { id: 'autostart', label: t.startup, value: unavailable('autostart', onOff(facts.autostart)) },
      { id: 'scale', label: t.size, value: sizeLabel(t, cfg.scale) },
      { id: 'sound', label: t.sound, value: cfg.muted ? t.mute : `${Math.round((cfg.volume ?? 0.7) * 100)} %` },
      { id: 'screen', label: t.screen, value: sc ? `${sc.index + 1} / ${sc.count} — ${sc.width}×${sc.height}` : s.none },
      { id: 'follow', label: t.follow, value: onOff(cfg.follow !== false) },
      { id: 'render', label: t.display, value: pick([['auto', t.displayAuto], ['gl', t.displayGl], ['software', t.displaySoftware]], cfg.render, t.displayAuto) },
    ],
    behavior: [
      { id: 'motion', label: t.motion, value: pick([['auto', t.motionAuto], ['full', t.motionFull], ['reduced', t.motionReduced]], cfg.motion, t.motionAuto) },
      { id: 'rest', label: t.rest, value: pick([['corner', t.restCorner], ['taskbar', t.restTaskbar]], cfg.rest, t.restCorner) },
      { id: 'wander', label: t.wander, value: onOff(cfg.wander) },
      { id: 'possess', label: t.possess, value: unavailable('windowTracking', onOff(cfg.possess)) },
      { id: 'jealous', label: t.jealous, value: onOff(cfg.jealous !== false) },
      { id: 'pcReact', label: t.pcReact, value: onOff(cfg.pcReact !== false) },
      { id: 'watchScreen', label: t.lookAuto, value: onOff(Boolean(cfg.watchScreen)) },
    ],
    ai: [
      { id: 'assistant', label: t.watch, value: watched ? watched.name : t.watchNone },
      ...(watched ? [{ id: 'hooks', label: `${s.hooks} ${watched.name}`, value: onOff(facts.hooksInstalled) }] : []),
      { id: 'provider', label: s.provider, value: facts.provider || s.none },
      { id: 'model', label: s.model, value: facts.model || s.none },
    ],
    about: [
      { id: 'version', label: s.version, value: about.version || s.none },
      {
        id: 'system',
        label: s.system,
        value: [OS_NAMES[about.platform] || about.platform, about.arch, about.session].filter(Boolean).join(' · ') || s.none,
      },
      { id: 'electron', label: s.electron, value: about.electron || s.none },
      { id: 'license', label: s.license, value: 'PolyForm Noncommercial 1.0.0' },
    ],
  };

  return {
    lang,
    title: s.title,
    nav: s.nav,
    close: s.close,
    openMenu: s.openMenu,
    readOnly: s.readOnly,
    sections: SECTIONS.map((id) => ({ id, title: s[id], fromMenu: id !== 'about', rows: rows[id] })),
  };
}

module.exports = { settingsView, SECTIONS };
