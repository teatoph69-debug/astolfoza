// Windows 98 UI components (DOM builders) used by every screen.
// All visuals come from src/ui/styles/base.css + shell.css.

import { h } from './dom.js';
import { icon } from './icons.js';

/** A window frame: title bar (icon, text, controls) + optional menubar, body and status bar. */
export function win98Window({ title = '', iconName = null, controls = ['close'], onControl = null, menubar = null, body = null, status = null, className = '' } = {}) {
  const titleText = h('div.win-title-text', title);
  const ctrl = h('div.win-controls');
  const buttons = {};
  for (const c of controls) {
    const b = h(`button.b-${c}`, { 'aria-label': c, tabindex: -1, onclick: (e) => { e.stopPropagation(); onControl && onControl(c, e); } });
    buttons[c] = b;
    ctrl.append(b);
  }
  const titleBar = h('div.win-title', iconName ? icon(iconName, 16, 'win-title-icon') : null, titleText, ctrl);
  const bodyEl = h('div.win-body', body);
  const statusEl = status ? h('div.win-statusbar', status) : null;
  const root = h(`div.win${className ? '.' + className.split(' ').join('.') : ''}`, titleBar, menubar ? buildMenubar(menubar) : null, bodyEl, statusEl);
  return {
    root, titleBar, body: bodyEl, status: statusEl, buttons,
    setTitle(t) { titleText.textContent = t; },
    setActive(a) { titleBar.classList.toggle('inactive', !a); },
  };
}

/** Menubar: [{ label: 'Файл', items: [{label, onClick, shortcut, disabled, separator}] }] */
export function buildMenubar(menus) {
  const bar = h('div.win-menubar');
  let openMenu = null;
  const closeAll = () => {
    if (openMenu) { openMenu.el.remove(); openMenu.btn.classList.remove('open'); openMenu = null; }
    document.removeEventListener('pointerdown', onDoc, true);
  };
  const onDoc = (e) => { if (openMenu && !openMenu.el.contains(e.target) && !bar.contains(e.target)) closeAll(); };
  for (const m of menus) {
    const btn = h('button', { html: underlineFirst(m.label) });
    btn.addEventListener('click', () => {
      if (openMenu && openMenu.btn === btn) { closeAll(); return; }
      closeAll();
      const el = contextMenu(m.items, () => closeAll());
      const r = btn.getBoundingClientRect();
      el.style.left = `${r.left}px`;
      el.style.top = `${r.bottom}px`;
      document.body.appendChild(el);
      btn.classList.add('open');
      openMenu = { el, btn };
      document.addEventListener('pointerdown', onDoc, true);
    });
    bar.append(btn);
  }
  return bar;
}

function underlineFirst(label) {
  const s = String(label);
  return `<u>${escapeHtml(s[0])}</u>${escapeHtml(s.slice(1))}`;
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** Floating menu (used by menubars, Start submenus and right-click). */
export function contextMenu(items, onDone) {
  const el = h('div.menu98');
  for (const it of items) {
    if (it.separator) { el.append(h('div.menu98-sep')); continue; }
    const row = h('button.menu98-item', {
      disabled: !!it.disabled,
      onclick: (e) => { e.stopPropagation(); onDone && onDone(); it.onClick && it.onClick(); },
    },
    h('span.menu98-check', it.checked ? '✓' : ''),
    it.icon ? icon(it.icon, 16) : h('span.menu98-noicon'),
    h('span.menu98-label', it.label),
    h('span.menu98-key', it.shortcut || ''));
    el.append(row);
  }
  return el;
}

export function button98(label, onClick, { primary = false, disabled = false, iconName = null, className = '' } = {}) {
  return h(`button.btn98${primary ? '.default' : ''}${className ? '.' + className : ''}`, { onclick: onClick, disabled }, iconName ? icon(iconName, 16) : null, label);
}

export function groupbox(legend, ...children) {
  return h('fieldset.groupbox', h('legend', legend), ...children);
}

export function checkbox98(label, checked, onChange, { id } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, id, onchange: (e) => onChange && onChange(e.target.checked) });
  return h('label.check', input, h('span', label));
}

export function radio98(name, options, value, onChange) {
  return h('div.radio-group', options.map((o) => {
    const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === value, onchange: () => onChange && onChange(o.value) });
    return h('label.radio', input, h('span', o.label));
  }));
}

/** Win98 trackbar with a value readout. */
export function slider98({ label, min, max, step = 1, value, format = (v) => v, onInput, id }) {
  const out = h('span.slider98-val.tnum', format(value));
  const input = h('input', { type: 'range', min, max, step, value, id, oninput: (e) => { const v = +e.target.value; out.textContent = format(v); onInput && onInput(v); } });
  return h('div.slider98', h('div.slider98-head', h('span', label), out), input);
}

/** Tabs: [{id, label, render: () => Node}] — returns {root, select(id)} */
export function tabs98(tabs, { active = tabs[0]?.id, onChange } = {}) {
  const bar = h('div.tabs98', { role: 'tablist' });
  const panel = h('div.tabpanel98', { role: 'tabpanel' });
  const btns = {};
  const cache = {};
  const select = (id) => {
    for (const [k, b] of Object.entries(btns)) b.setAttribute('aria-selected', String(k === id));
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (!cache[id]) cache[id] = t.render();
    panel.replaceChildren(cache[id]);
    onChange && onChange(id);
  };
  for (const t of tabs) {
    const b = h('button', { role: 'tab', onclick: () => select(t.id) }, t.label);
    btns[t.id] = b;
    bar.append(b);
  }
  const root = h('div.tabs98-wrap', bar, panel);
  select(active);
  return { root, select, panel };
}

/** Segmented Win98 progress bar. set(0..1) */
export function progress98({ value = 0, segmented = true, color = '', label = '' } = {}) {
  const bar = h('div.bar');
  const lab = label !== false ? h('div.label') : null;
  const root = h(`div.progress98${segmented ? '.segmented' : ''}${color ? '.' + color : ''}`, bar, lab);
  const api = {
    root,
    set(v, text) {
      const p = Math.max(0, Math.min(1, v));
      bar.style.width = `${(p * 100).toFixed(1)}%`;
      if (lab) lab.textContent = text ?? '';
    },
  };
  api.set(value, label || '');
  return api;
}

/** Desktop icon: single click selects, double click (or Enter / tap) opens. */
export function desktopIcon({ iconName, label, onOpen, title }) {
  const el = h('button.desk-icon', { title: title || label },
    h('span.desk-icon-img', icon(iconName, 32)),
    h('span.desk-icon-label', label));
  el.addEventListener('click', (e) => {
    document.querySelectorAll('.desk-icon.selected').forEach((x) => x !== el && x.classList.remove('selected'));
    el.classList.add('selected');
    if (e.pointerType === 'touch' || e.detail === 0) onOpen && onOpen();
  });
  el.addEventListener('dblclick', () => onOpen && onOpen());
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen && onOpen(); } });
  return el;
}

/** List view (details view) — columns: [{key, label, width, align, format}] */
export function listview98(columns, rows, { onSelect, onOpen, selectedIndex = -1, rowClass } = {}) {
  const thead = h('thead', h('tr', columns.map((c) => h('th', { style: { width: c.width || 'auto', textAlign: c.align || 'left' } }, c.label))));
  const tbody = h('tbody');
  const table = h('table', thead, tbody);
  const root = h('div.listview98', table);
  let sel = selectedIndex;
  const trs = [];
  const render = (data) => {
    tbody.replaceChildren();
    trs.length = 0;
    data.forEach((r, i) => {
      const tr = h('tr', { tabindex: -1, class: rowClass ? rowClass(r) : '' }, columns.map((c) => {
        const v = c.format ? c.format(r[c.key], r) : r[c.key];
        return h('td', { style: { textAlign: c.align || 'left' } }, v instanceof Node ? v : String(v ?? ''));
      }));
      tr.addEventListener('click', () => api.select(i));
      tr.addEventListener('dblclick', () => onOpen && onOpen(data[i], i));
      trs.push(tr);
      tbody.append(tr);
    });
    api.data = data;
  };
  const api = {
    root,
    data: rows,
    select(i, { silent = false } = {}) {
      if (sel >= 0 && trs[sel]) trs[sel].classList.remove('selected');
      sel = i;
      if (trs[i]) { trs[i].classList.add('selected'); trs[i].scrollIntoView({ block: 'nearest' }); }
      if (!silent && onSelect && api.data[i]) onSelect(api.data[i], i);
    },
    get selected() { return sel; },
    setRows(data) { render(data); if (sel >= data.length) sel = -1; if (sel >= 0) api.select(sel, { silent: true }); },
  };
  render(rows);
  if (sel >= 0) api.select(sel, { silent: true });
  return api;
}
