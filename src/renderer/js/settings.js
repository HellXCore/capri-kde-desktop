// Her settings window: sections as tabs on the left, the open one on the right. What it shows comes
// from main (settings-view.js), already in her language; it's drawn again whenever main sends a new
// view, keeping the open section. Keyboard: Tab moves through, the arrows/Home/End move between
// sections, Escape closes the window.

const host = window.settingsHost;
const tabs = document.getElementById('tabs');
const panels = document.getElementById('panels');
const title = document.getElementById('title');
const closeButton = document.getElementById('close');

let current = null; // the id of the open section
let view = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(id, { focus = false } = {}) {
  current = id;
  for (const tab of tabs.children) {
    const on = tab.dataset.id === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const panel of panels.children) panel.hidden = panel.dataset.id !== id;
  panels.scrollTop = 0;
}

function section(s) {
  const panel = el('section', 'settings__panel');
  panel.id = `panel-${s.id}`;
  panel.dataset.id = s.id;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${s.id}`);
  panel.tabIndex = 0; // read-only content: reachable with Tab, and scrollable with the arrows
  panel.append(el('h2', 'settings__heading', s.title));
  if (s.fromMenu) {
    const note = el('div', 'settings__note');
    const menu = el('button', 'settings__button', view.openMenu);
    menu.type = 'button';
    menu.addEventListener('click', () => host.openMenu());
    note.append(el('p', 'settings__noteText', view.readOnly), menu);
    panel.append(note);
  }
  const list = el('dl', 'settings__rows');
  for (const row of s.rows) {
    const item = el('div', 'settings__row');
    item.dataset.id = row.id;
    item.append(el('dt', 'settings__label', row.label), el('dd', 'settings__value', row.value));
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function render(next) {
  view = next;
  document.documentElement.lang = view.lang;
  document.title = view.title;
  title.textContent = view.title;
  tabs.setAttribute('aria-label', view.nav);
  closeButton.textContent = view.close;
  const hadFocus = tabs.contains(document.activeElement);
  tabs.replaceChildren(...view.sections.map((s) => {
    const tab = el('button', 'settings__tab', s.title);
    tab.type = 'button';
    tab.id = `tab-${s.id}`;
    tab.dataset.id = s.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${s.id}`);
    tab.addEventListener('click', () => select(s.id));
    return tab;
  }));
  panels.replaceChildren(...view.sections.map(section));
  const ids = view.sections.map((s) => s.id);
  select(ids.includes(current) ? current : ids[0], { focus: hadFocus });
}

tabs.addEventListener('keydown', (e) => {
  const list = [...tabs.children];
  const at = list.findIndex((tab) => tab.dataset.id === current);
  const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  select(list[(to + list.length) % list.length].dataset.id, { focus: true });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    host.close();
  }
});
closeButton.addEventListener('click', () => host.close());

host.onView(render);
render(await host.view());
tabs.querySelector('[aria-selected="true"]')?.focus();
host.ready({ sections: view.sections.length, focused: document.activeElement?.id || null });
