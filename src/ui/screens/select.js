// «Мои карты» — Explorer-style song select.
//   toolbar (back · quick play/watch/versus · import/delete · music preview · search)
//   left: list view of mapsets (sortable columns) · right: difficulty list, details, note-density
//   graph (Task-Manager style), live 3D preview synced to the music preview, mode tabs with the
//   МУХА brain picker, mods and the big «Старт» button · status bar.
//
// params: { mode: 'play'|'watch'|'versus', focusSet?: setId }
// Keyboard: ↑/↓ set · ←/→ difficulty · PgUp/PgDn · Enter start · 1/2/3 mode · Esc back · type to search

import { Screen } from '../app.js';
import { h, clear, hiDPICanvas } from '../dom.js';
import { tr, getLang, fmtNum, plural } from '../i18n.js';
import { local } from '../store.js';
import { icon } from '../icons.js';
import { button98 } from '../win98.js';
import { starColor, formatTime, packNotes } from '../../core/map.js';
import { HAND_PRESETS } from '../../ai/agent.js';
import { Playfield } from '../../render/playfield.js';
import {
  uiSfx, confirmDialog, isModalOpen, brainName, titleName, sourceLabel, fadeMusicIn, restoreMusicVolume,
  listen, unlistenAll, closeProgram,
} from './menu.js';

const SPEEDS = [0.75, 0.85, 1, 1.15, 1.25, 1.45];
const MODES = ['play', 'watch', 'versus'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Cached per-map analysis (density, NPS, cell heat). */
const statsCache = new WeakMap();
export function mapStats(map) {
  let s = statsCache.get(map);
  if (s) return s;
  const notes = map.notes || [];
  const n = notes.length;
  const first = n ? notes[0].t : 0;
  const last = n ? notes[n - 1].t : 0;
  const duration = Math.max(map.duration || 0, last + 1, 1);
  const span = Math.max(1, last - first);
  let peak = 0;
  for (let i = 0, j = 0; i < n; i++) {
    while (notes[i].t - notes[j].t > 1) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const bins = Math.round(clamp(duration * 1.2, 48, 150));
  const dens = new Float32Array(bins);
  const bw = duration / bins;
  for (const nt of notes) dens[Math.min(bins - 1, Math.max(0, Math.floor(nt.t / bw)))] += 1 / bw;
  const heat = new Float32Array(9);
  for (const nt of notes) heat[clamp(Math.round(nt.y), 0, 2) * 3 + clamp(Math.round(nt.x), 0, 2)]++;
  const hmax = Math.max(1, ...heat);
  for (let i = 0; i < 9; i++) heat[i] /= hmax;
  s = { n, first, last, duration, nps: n / span, peak, dens, heat };
  statsCache.set(map, s);
  return s;
}

const setMaxStars = (set) => set.maps.reduce((m, x) => Math.max(m, x.stars || 0), 0);
const setMinStars = (set) => set.maps.reduce((m, x) => Math.min(m, x.stars || 0), Infinity);
const sortedMaps = (set) => set.maps.slice().sort((a, b) => (a.stars || 0) - (b.stars || 0));
const starStr = (s) => (s || 0).toFixed(2);

export class SelectScreen extends Screen {
  mount() {
    const app = this.app;
    unlistenAll('select');
    this.mode = 'play';
    this.query = '';
    this.sort = local.get('sel.sort2', { key: 'default', dir: 1 });
    this.previewOn = local.get('sel.preview', true) !== false;
    this.setId = null;
    this.mapId = null;
    this.visible = false;
    listen('select', app.library, 'change', () => this._onLibraryChange());
    listen('select', app.brains, 'change', () => { if (this.visible) this._renderLaunch(); });
    listen('select', app, 'settings', () => { if (this.pf) try { this.pf.setSettings(this._pfSettings()); } catch { /* ignore */ } });
  }

  // ---- window chrome (read once when the frame is created) -----------------------------------------

  title() { return this._title(); }

  _title() {
    const m = { play: tr('Играть', 'Play'), watch: tr('Смотреть МУХУ', 'Watch МУХА'), versus: tr('Против МУХИ', 'Versus МУХА') }[this.mode || 'play'];
    return `${tr('Мои карты', 'My Maps')} — ${m}`;
  }

  menubar() {
    const self = this;
    const sortItem = (key, label) => ({ label, get checked() { return self.sort.key === key; }, onClick: () => self._setSort(key, true) });
    const modeItem = (mode, label, key) => ({ label, shortcut: key, get checked() { return self.mode === mode; }, onClick: () => self._setMode(mode) });
    return [
      { label: tr('Файл', 'File'), items: [
        { label: tr('Импорт карт…', 'Import maps…'), icon: 'floppy', onClick: () => this.app.emit('import-request') },
        { label: tr('Удалить набор карт…', 'Delete mapset…'), icon: 'bin', get disabled() { const s = self._set(); return !s || s.source === 'builtin'; }, onClick: () => { const s = self._set(); if (s) self._deleteSet(s); } },
        { separator: true },
        { label: tr('Старт', 'Start'), icon: 'play', shortcut: 'Enter', onClick: () => this._start() },
        { separator: true },
        { label: tr('Закрыть', 'Close'), onClick: () => closeProgram(this.app, 'select') },
      ] },
      { label: tr('Вид', 'View'), items: [
        { label: tr('Превью музыки', 'Music preview'), get checked() { return self.previewOn; }, onClick: () => self._togglePreview() },
        { separator: true },
        sortItem('default', tr('По порядку', 'Default order')),
        sortItem('title', tr('По названию', 'By title')),
        sortItem('artist', tr('По исполнителю', 'By artist')),
        sortItem('stars', tr('По сложности', 'By difficulty')),
        sortItem('bpm', tr('По BPM', 'By BPM')),
      ] },
      { label: tr('Режим', 'Mode'), items: [
        modeItem('play', tr('Играть', 'Play'), '1'),
        modeItem('watch', tr('Смотреть МУХУ', 'Watch МУХА'), '2'),
        modeItem('versus', tr('Против МУХИ', 'Versus МУХА'), '3'),
      ] },
      { label: tr('Справка', 'Help'), items: [
        { label: tr('Справка.txt', 'Help.txt'), icon: 'notepad', onClick: () => this.app.emit('help-request') },
      ] },
    ];
  }

  statusbar() {
    this.sbCount = h('div.status-field.sel-sb-count');
    this.sbMap = h('div.status-field');
    this.sbAudio = h('div.status-field.fit.sel-sb-audio');
    return [this.sbCount, this.sbMap, this.sbAudio];
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  show(params = {}) {
    this.visible = true;
    if (params.mode && MODES.includes(params.mode)) this.mode = params.mode;
    if (this._builtLang !== getLang()) this.build();
    const lib = this.app.library;
    let set = params.focusSet ? lib.getSet(params.focusSet) : null;
    let map = null;
    if (set) { this.query = ''; this.searchInput.value = ''; }
    if (!set) {
      const last = lib.getMap(local.get('sel.last', ''));
      if (last) { set = lib.getSet(last.setId); map = last; }
    }
    if (!set) set = this._visibleSets()[0] || null;
    this.setTitle(this._title());
    this._renderTabs();
    this._renderList();
    this._select(set ? set.id : null, map ? map.id : null, { scroll: true });
    this._renderLaunch();
    this._startLoop();
  }

  hide() {
    this.visible = false;
    this._stopLoop();
    this._stopPreview();
    clearTimeout(this._previewTimer);
  }

  resize() { this._layoutCanvases(); }

  // ---- DOM -------------------------------------------------------------------------------------

  build() {
    const app = this.app;
    this._builtLang = getLang();
    const tool = (iconName, label, fn, title) => h('button.tool-btn.sel-tool', { type: 'button', title: title || label, onclick: fn }, icon(iconName, 16), h('span', label));
    this.searchInput = h('input.sel-search', {
      type: 'search', placeholder: tr('название, исполнитель…', 'title, artist…'), spellcheck: false, autocomplete: 'off',
      oninput: () => { this.query = this.searchInput.value; this._renderList(); this._ensureSelectionVisible(); },
    });
    this.delBtn = tool('bin', tr('Удалить', 'Delete'), () => { const s = this._set(); if (s) this._deleteSet(s); }, tr('Удалить импортированный набор карт', 'Delete the imported mapset'));
    this.previewBtn = tool('music', tr('Превью', 'Preview'), () => this._togglePreview(), tr('Музыкальное превью', 'Music preview'));
    const toolbar = h('div.sel-toolbar',
      h('button.tool-btn.sel-tool.sel-back', { type: 'button', title: tr('Назад (Esc)', 'Back (Esc)'), onclick: () => this._back() }, h('span.sel-arrow', '◄'), h('span', tr('Назад', 'Back'))),
      h('div.vseparator'),
      tool('play', tr('Играть', 'Play'), () => this._start('play'), tr('Играть выбранную карту', 'Play the selected map')),
      tool('watch', tr('Смотреть', 'Watch'), () => this._start('watch'), tr('МУХА играет выбранную карту', 'МУХА plays the selected map')),
      tool('versus', tr('Против', 'Versus'), () => this._start('versus'), tr('Сразиться с МУХОЙ', 'Challenge МУХА')),
      h('div.vseparator'),
      tool('floppy', tr('Импорт', 'Import'), () => app.emit('import-request'), tr('Импорт карт (.sspm, .txt, mp3…)', 'Import maps (.sspm, .txt, mp3…)')),
      this.delBtn,
      h('div.vseparator'),
      this.previewBtn,
      h('label.sel-search-wrap', h('span', tr('Поиск:', 'Search:')), this.searchInput));

    this.setsBody = h('tbody');
    this.setsHead = h('thead');
    this.setsTable = h('table', this.setsHead, this.setsBody);
    this.setsView = h('div.listview98.sel-sets', { tabindex: 0 }, this.setsTable);

    this.detailEl = h('div.sel-details');
    this.tabsEl = h('div.tabs98.sel-tabs', { role: 'tablist' });
    this.launchEl = h('div.tabpanel98.sel-launch');

    clear(this.el).append(
      h('div.sel-root',
        toolbar,
        h('div.sel-main',
          h('div.sel-left', this.setsView),
          h('div.sel-right',
            this.detailEl,
            h('div.sel-launch-wrap', this.tabsEl, this.launchEl)))));
    this._renderPreviewBtn();
  }

  _renderTabs() {
    const labels = { play: tr('Играть', 'Play'), watch: tr('Смотреть МУХУ', 'Watch МУХА'), versus: tr('Против МУХИ', 'Versus МУХА') };
    clear(this.tabsEl).append(...MODES.map((m, i) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(this.mode === m), title: `${labels[m]} (${i + 1})`,
      onclick: () => { if (this.mode !== m) { uiSfx(this.app); this._setMode(m); } },
    }, icon(m === 'play' ? 'play' : m, 16), h('span', labels[m]))));
  }

  _setMode(mode) {
    this.mode = mode;
    if (this._params) this._params.mode = mode;
    this.setTitle(this._title());
    this._renderTabs();
    this._renderLaunch();
  }

  _set() { return this.setId ? this.app.library.getSet(this.setId) : null; }
  _map() { return this.mapId ? this.app.library.getMap(this.mapId) : null; }

  // ---- sets list view ---------------------------------------------------------------------------------

  _columns() {
    return [
      { key: 'title', label: tr('Название', 'Title'), cls: 'c-title' },
      { key: 'artist', label: tr('Исполнитель', 'Artist'), cls: 'c-artist' },
      { key: 'stars', label: '★', cls: 'c-stars num' },
      { key: 'maps', label: tr('Карт', 'Maps'), cls: 'c-maps num' },
      { key: 'bpm', label: 'BPM', cls: 'c-bpm num' },
      { key: 'source', label: tr('Источник', 'Source'), cls: 'c-src' },
    ];
  }

  _setSort(key, fromMenu = false) {
    if (fromMenu || this.sort.key !== key) this.sort = { key, dir: 1 };
    else if (this.sort.dir === 1) this.sort = { key, dir: -1 };
    else this.sort = { key: 'default', dir: 1 };
    local.set('sel.sort2', this.sort);
    this._renderList();
    this._scrollToSelected();
  }

  _visibleSets() {
    const lib = this.app.library;
    if (!lib) return [];
    const q = this.query.trim().toLowerCase();
    let sets = lib.sets.filter((s) => s.maps && s.maps.length);
    if (q) {
      const words = q.split(/\s+/);
      sets = sets.filter((s) => {
        const hay = [s.title, s.artist, s.mapper, s.style, sourceLabel(s.source), ...s.maps.map((m) => `${m.difficultyName} ${m.mapper || ''}`)].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const by = {
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title),
      stars: (a, b) => setMaxStars(a) - setMaxStars(b),
      maps: (a, b) => a.maps.length - b.maps.length,
      bpm: (a, b) => (a.bpm || 0) - (b.bpm || 0),
      source: (a, b) => sourceLabel(a.source).localeCompare(sourceLabel(b.source)),
    }[this.sort.key];
    if (by) sets = sets.slice().sort((a, b) => by(a, b) * this.sort.dir);
    return sets;
  }

  _renderList() {
    const sets = this._visibleSets();
    this._sets = sets;
    const lib = this.app.library;
    const nSets = lib ? lib.sets.length : 0;
    const nMaps = lib ? lib.sets.reduce((a, s) => a + s.maps.length, 0) : 0;
    if (this.sbCount) {
      this.sbCount.textContent = getLang() === 'en'
        ? `${nMaps} maps · ${nSets} songs${this.query ? ` · found ${sets.length}` : ''}`
        : `${nMaps} ${plural(nMaps, 'карта', 'карты', 'карт')} · ${nSets} ${plural(nSets, 'песня', 'песни', 'песен')}${this.query ? ` · найдено ${sets.length}` : ''}`;
    }
    clear(this.setsHead).append(h('tr', this._columns().map((c) => h(`th.${c.cls.split(' ').join('.')}`, {
      onclick: () => { uiSfx(this.app, 'ui', 0.3); this._setSort(c.key); },
      title: tr('Сортировать', 'Sort'),
    }, c.label, this.sort.key === c.key ? h('span.sel-sort-arrow', this.sort.dir > 0 ? ' ▲' : ' ▼') : null))));
    clear(this.setsBody);
    this._rows = new Map();
    if (!sets.length) {
      this.setsBody.appendChild(h('tr.sel-empty-row', h('td', { colSpan: 6 },
        this.query ? tr(`Ничего не найдено по запросу «${this.query}».`, `Nothing matches “${this.query}”.`) : tr('Библиотека пуста — импортируй карты.', 'The library is empty — import some maps.'))));
      return;
    }
    for (const set of sets) {
      const lo = setMinStars(set), hi = setMaxStars(set);
      const tr_ = h('tr', {
        dataset: { id: set.id },
        onclick: () => { if (this.setId !== set.id) { uiSfx(this.app, 'ui', 0.25); this._select(set.id, null, { scroll: false }); } },
        ondblclick: () => this._start(),
      },
      h('td.c-title', h('span.sel-cell', icon(set.source === 'builtin' ? 'music' : 'mapfile', 16), h('span', set.title))),
      h('td.c-artist', set.artist || '—'),
      h('td.c-stars.num', lo === hi ? lo.toFixed(1) : `${lo.toFixed(1)}–${hi.toFixed(1)}`),
      h('td.c-maps.num', String(set.maps.length)),
      h('td.c-bpm.num', set.bpm ? String(Math.round(set.bpm)) : '—'),
      h('td.c-src', sourceLabel(set.source)));
      this._rows.set(set.id, tr_);
      this.setsBody.appendChild(tr_);
    }
    this._markSelected();
  }

  _markSelected() {
    if (!this._rows) return;
    for (const [id, row] of this._rows) row.classList.toggle('selected', id === this.setId);
  }

  _scrollToSelected() {
    const row = this._rows?.get(this.setId);
    if (!row) return;
    const view = this.setsView;
    const head = this.setsHead.offsetHeight || 19;
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top - head < view.scrollTop) view.scrollTop = top - head;
    else if (bottom > view.scrollTop + view.clientHeight) view.scrollTop = bottom - view.clientHeight;
  }

  _ensureSelectionVisible() {
    if (this._sets.length && !this._sets.some((s) => s.id === this.setId)) this._select(this._sets[0].id, null, { scroll: true });
  }

  _onLibraryChange() {
    if (!this.visible) { this._builtLang = null; return; }
    const lib = this.app.library;
    this._renderList();
    if (!lib.getSet(this.setId)) {
      const first = this._visibleSets()[0];
      this._select(first ? first.id : null, null, { scroll: true });
    } else {
      this._select(this.setId, lib.getMap(this.mapId) ? this.mapId : null, { scroll: false, keepPreview: true });
    }
  }

  // ---- selection -------------------------------------------------------------------------------------

  _select(setId, mapId = null, { scroll = true, keepPreview = false } = {}) {
    const lib = this.app.library;
    const set = setId ? lib.getSet(setId) : null;
    const setChanged = setId !== this.setId;
    this.setId = set ? set.id : null;
    if (!set) {
      this.mapId = null;
      this._markSelected();
      this._renderDetail();
      this._stopPreview();
      this._renderLaunch();
      return;
    }
    const maps = sortedMaps(set);
    let map = mapId ? maps.find((m) => m.id === mapId) : null;
    if (!map && this.mapId) {
      const prev = lib.getMap(this.mapId);
      if (prev && prev.setId === set.id) map = prev;
      else if (prev) map = maps.reduce((best, m) => (Math.abs(m.stars - prev.stars) < Math.abs(best.stars - prev.stars) ? m : best), maps[0]);
    }
    if (!map) map = maps[Math.floor((maps.length - 1) / 2)];
    const hadMap = !!this.mapId;
    this.mapId = map.id;
    local.set('sel.last', map.id);
    this._markSelected();
    if (scroll) this._scrollToSelected();
    this._renderDetail();
    this._resetPreviewClock();
    this.delBtn.disabled = set.source === 'builtin';
    if (setChanged && !keepPreview) this._schedulePreview();
    if (!hadMap) this._renderLaunch();
  }

  _selectMap(mapId) {
    if (mapId === this.mapId) return;
    this.mapId = mapId;
    local.set('sel.last', mapId);
    this._renderDetail();
    this._resetPreviewClock();
  }

  _step(dir) {
    const sets = this._sets || [];
    if (!sets.length) return;
    let i = sets.findIndex((s) => s.id === this.setId);
    i = i < 0 ? 0 : clamp(i + dir, 0, sets.length - 1);
    if (sets[i].id === this.setId) return;
    uiSfx(this.app, 'ui', 0.25);
    this._select(sets[i].id, null, { scroll: true });
  }

  _stepDiff(dir) {
    const set = this._set();
    if (!set) return;
    const maps = sortedMaps(set);
    const i = maps.findIndex((m) => m.id === this.mapId);
    const j = clamp(i + dir, 0, maps.length - 1);
    if (j !== i) { uiSfx(this.app, 'ui', 0.25); this._selectMap(maps[j].id); }
  }

  // ---- details -----------------------------------------------------------------------------------

  _renderDetail() {
    const app = this.app;
    const el = this.detailEl;
    const set = this._set();
    const map = this._map();
    clear(el);
    this.pf = null;
    if (!set || !map) {
      el.appendChild(h('div.sel-nothing.sunken', icon('folder', 32), h('div', tr('Выбери карту в списке слева.', 'Pick a map in the list.'))));
      if (this.sbMap) this.sbMap.textContent = '';
      return;
    }
    const st = mapStats(map);
    const speed = app.settings.mods?.speed || 1;
    const best = local.get('best.' + map.id, null);
    const maps = sortedMaps(set);
    if (this.sbMap) this.sbMap.textContent = `${set.title} — ${map.difficultyName || '?'} ★${starStr(map.stars)} · ${fmtNum(st.n)} ${tr('нот', 'notes')}`;

    // header: cover (3×3 note heat) + text + big stars
    const cover = h('div.sel-cover.sunken', Array.from(st.heat).map((v) => h('i', { style: `opacity:${(0.1 + v * 0.9).toFixed(2)}` })));
    const head = h('div.sel-head',
      cover,
      h('div.sel-head-text',
        h('div.sel-head-title', set.title),
        h('div.sel-head-artist', set.artist || '—'),
        h('div.sel-head-meta', `${tr('Маппер', 'Mapper')}: ${map.mapper || set.mapper || '—'} · ${sourceLabel(set.source)}${set.bpm ? ` · ${Math.round(set.bpm)} BPM` : ''}`)),
      h('div.sel-head-stars',
        h('div.sel-stars.display', '★' + starStr(map.stars)),
        h('div.sel-stars-name', map.difficultyName || '—')));

    // difficulties list
    const diffBody = h('tbody', maps.map((m) => {
      const ms = mapStats(m);
      return h(`tr${m.id === map.id ? '.selected' : ''}`, {
        onclick: () => { uiSfx(app, 'ui', 0.25); this._selectMap(m.id); },
        ondblclick: () => this._start(),
      },
      h('td', h('span.sel-cell', h('i.sel-swatch', { style: `background:${starColor(m.stars)}` }), h('span', m.difficultyName || '—'))),
      h('td.num', starStr(m.stars)),
      h('td.num', fmtNum(ms.n)),
      h('td.num', formatTime(ms.duration)),
      h('td.num', ms.nps.toFixed(1)));
    }));
    const diffs = h('div.listview98.sel-diffs', h('table',
      h('thead', h('tr', h('th', tr('Сложность', 'Difficulty')), h('th.num', '★'), h('th.num', tr('Ноты', 'Notes')), h('th.num', tr('Длина', 'Length')), h('th.num', 'NPS'))),
      diffBody));

    // stats
    const rows = [
      [tr('Ноты', 'Notes'), fmtNum(st.n)],
      [tr('Длина', 'Length'), speed !== 1 ? `${formatTime(st.duration / speed)} (${speed}×)` : formatTime(st.duration)],
      [tr('Нот/с', 'Notes/s'), `${(st.nps * speed).toFixed(1)} · ${tr('пик', 'peak')} ${Math.round(st.peak * speed)}`],
      [tr('Рекорд', 'Best'), best ? `${best.grade?.name || ''} · ${fmtNum(best.score || 0)} · ${((best.accuracy || 0) * 100).toFixed(2)}%` : tr('ещё не сыграна', 'not played yet')],
    ];
    const stats = h('table.sel-stats', h('tbody', rows.map(([k, v]) => h('tr', h('th', k), h('td', v)))));

    this.densCanvas = h('canvas.sel-dens-canvas');
    this.playhead = h('div.sel-playhead');
    this.pfCanvas = h('canvas.sel-pf-canvas');
    const viz = h('div.sel-viz',
      h('fieldset.groupbox.sel-dens-box', h('legend', tr('Плотность нот', 'Note density')),
        h('div.sunken.black.sel-dens', this.densCanvas, this.playhead)),
      h('fieldset.groupbox.sel-pf-box', h('legend', tr('Превью', 'Preview')),
        h('div.sunken.black.sel-pf', this.pfCanvas)));

    el.append(
      h('fieldset.groupbox.sel-map-box', h('legend', tr('Карта', 'Map')), head, set.mood && getLang() === 'ru' ? h('div.sel-mood', set.mood) : null),
      h('fieldset.groupbox', h('legend', tr('Сложность', 'Difficulty') + ' (← →)'), diffs, stats),
      viz);
    this._pfPacked = null;
    this._pfKey = null;
    try { this.pf = new Playfield(this.pfCanvas, this._pfSettings()); } catch (e) { console.warn('preview renderer unavailable', e); this.pf = null; }
    requestAnimationFrame(() => this._layoutCanvases());
    this._renderPreviewStatus();
  }

  _layoutCanvases() {
    if (!this.densCanvas || !this.densCanvas.isConnected) return;
    this._drawDensity();
    if (this.pf) try { this.pf.resize(); } catch { /* ignore */ }
  }

  /** Task-Manager-style note density history: green grid + bars on black. */
  _drawDensity() {
    const map = this._map();
    if (!map) return;
    const st = mapStats(map);
    const c = hiDPICanvas(this.densCanvas);
    const { ctx, w, h: H } = c;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, H);
    const padB = 12;
    const gh = H - padB;
    ctx.strokeStyle = '#008040';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0.5; x < w; x += 12) { ctx.moveTo(x, 0); ctx.lineTo(x, gh); }
    for (let y = gh - 0.5; y > 0; y -= 12) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    const max = Math.max(1, ...st.dens);
    const n = st.dens.length;
    const bw = w / n;
    ctx.fillStyle = '#00ff00';
    for (let i = 0; i < n; i++) {
      const v = st.dens[i] / max;
      const bh = Math.round(v * (gh - 3));
      if (bh > 0) ctx.fillRect(Math.floor(i * bw), gh - bh, Math.max(1, Math.ceil(bw) - 1), bh);
    }
    const peakI = st.dens.indexOf(max);
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(Math.floor(peakI * bw), 1, Math.max(2, Math.ceil(bw) - 1), 3);
    ctx.fillStyle = '#00ff00';
    ctx.font = '10px "Lucida Console", "Courier New", monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText('0:00', 2, H);
    ctx.textAlign = 'center';
    ctx.fillText(`${tr('пик', 'peak')} ${Math.round(st.peak)}/${tr('с', 's')}`, w / 2, H);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(st.duration), w - 2, H);
    this._densDuration = st.duration;
  }

  // ---- 3D preview (the real game renderer, auto-played) ------------------------------------------------

  _pfSettings() {
    const s = this.app.settings;
    return { approachRate: s.approachRate, approachDistance: s.approachDistance, parallax: s.parallax, colorSet: s.colorSet, cursorTrail: s.cursorTrail, quality: s.quality, spin: false, fov: s.fov, noteOpacity: s.noteOpacity, backgroundDim: s.backgroundDim };
  }

  _packedForPreview() {
    const map = this._map();
    if (!map) return null;
    const mirror = !!this.app.settings.mods?.mirror;
    const key = map.id + (mirror ? ':m' : '');
    if (this._pfKey === key && this._pfPacked) return this._pfPacked;
    const notes = mirror ? map.notes.map((n) => ({ t: n.t, x: 2 - n.x, y: n.y })) : map.notes;
    this._pfPacked = packNotes(notes);
    this._pfState = new Uint8Array(this._pfPacked.n);
    this._pfKey = key;
    this._pfHead = 0;
    this._pfLastT = -1e9;
    return this._pfPacked;
  }

  _resetPreviewClock() {
    const map = this._map();
    const st = map ? mapStats(map) : null;
    const t0 = st ? Math.max(0, st.first - 1.2) : 0;
    this._clock = { t0, t: t0, loopLen: 12 };
    this._pfKey = null;
  }

  _previewTime(dt) {
    const a = this.app.audio;
    if (this._pv && this._pv.playing && a.playing && a.source === this._pv.src) return a.songTime();
    const c = this._clock;
    if (!c) return 0;
    c.t += dt * (this.app.settings.mods?.speed || 1);
    if (c.t > c.t0 + c.loopLen) { c.t = c.t0; this._pfKey = null; }
    return c.t;
  }

  _startLoop() {
    if (this._raf) return;
    let last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.hidden) return;
      this._tickPreview(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopLoop() { cancelAnimationFrame(this._raf); this._raf = 0; }

  _tickPreview(dt) {
    if (!this.pfCanvas || !this.pfCanvas.isConnected) return;
    const time = this._previewTime(dt);
    const pv = this._pv;
    if (pv && pv.playing && time > pv.start + 30) this._restartPreviewAudio();
    if (this._densDuration && this.playhead) {
      const on = !!(pv && pv.playing);
      this.playhead.style.display = on ? 'block' : 'none';
      if (on) this.playhead.style.left = `calc(2px + (100% - 4px) * ${clamp(time / this._densDuration, 0, 1).toFixed(4)})`;
    }
    const p = this._packedForPreview();
    if (!this.pf || !p) return;
    const state = this._pfState;
    if (time < this._pfLastT - 0.25) { state.fill(0); this._pfHead = 0; }
    this._pfLastT = time;
    const events = [];
    while (this._pfHead < p.n && p.t[this._pfHead] <= time) {
      if (p.t[this._pfHead] > time - 0.2) events.push({ type: 'hit', index: this._pfHead, time });
      state[this._pfHead] = 1;
      this._pfHead++;
    }
    const i = this._pfHead;
    const px = i > 0 ? p.x[i - 1] : 1, py = i > 0 ? p.y[i - 1] : 1, pt = i > 0 ? p.t[i - 1] : time - 1;
    let cx = px, cy = py;
    if (i < p.n) {
      const u = clamp((time - pt) / (Math.max(0.03, p.t[i] - pt) * 0.85), 0, 1);
      const e = u * u * (3 - 2 * u);
      cx = px + (p.x[i] - px) * e;
      cy = py + (p.y[i] - py) * e;
    }
    try {
      this.pf.draw({ time, notes: p, state, cursors: [{ x: cx, y: cy, color: '#ffffff', main: true, fly: true }], events, energy: 0.5, realDt: dt });
    } catch (e) {
      console.warn('preview draw failed', e);
      this.pf = null;
    }
  }

  // ---- music preview ------------------------------------------------------------------------------

  _togglePreview() {
    uiSfx(this.app);
    this.previewOn = !this.previewOn;
    local.set('sel.preview', this.previewOn);
    this._renderPreviewBtn();
    if (this.previewOn) this._schedulePreview(50);
    else this._stopPreview();
  }

  _renderPreviewBtn() {
    if (!this.previewBtn) return;
    this.previewBtn.classList.toggle('pressed', this.previewOn);
    this.previewBtn.setAttribute('aria-pressed', String(this.previewOn));
  }

  _schedulePreview(delay = 550) {
    clearTimeout(this._previewTimer);
    if (!this.previewOn) return;
    const setId = this.setId;
    this._stopPreview(true);
    this._pvLoading = setId;
    this._renderPreviewStatus();
    this._previewTimer = setTimeout(() => this._loadPreview(setId), delay);
  }

  async _loadPreview(setId) {
    const app = this.app;
    const set = app.library.getSet(setId);
    if (!set || !this.visible || setId !== this.setId || !this.previewOn) return;
    // audio needs a user gesture first (reaching this window always takes one)
    if ((set.audio && set.audio.kind === 'none') || !app.audio.ctx) { this._pvLoading = null; this._renderPreviewStatus(); return; }
    const token = (this._pvToken = (this._pvToken || 0) + 1);
    let buf = null;
    try { buf = await app.library.getAudioBuffer(set); } catch (e) { console.warn('preview audio', e); }
    if (token !== this._pvToken || !this.visible || setId !== this.setId || !this.previewOn) return;
    this._pvLoading = null;
    if (!buf) { this._renderPreviewStatus(); return; }
    const map = this._map();
    const st = map ? mapStats(map) : null;
    const dur = buf.duration || (st ? st.duration : 60);
    let start = dur * 0.36;
    if (st && st.n) start = clamp(start, st.first, Math.max(st.first, st.last - 10));
    start = clamp(start, 0, Math.max(0, dur - 12));
    this._pv = { setId, buf, start, playing: false, src: null };
    this._restartPreviewAudio(true);
    this._renderPreviewStatus();
  }

  _restartPreviewAudio(fade = false) {
    const pv = this._pv;
    if (!pv) return;
    const a = this.app.audio;
    try {
      a.play(pv.buf, { startAt: pv.start, rate: 1 });
      pv.src = a.source;
      pv.playing = true;
      this._pvEnded = () => { if (this._pv === pv && this.visible) this._restartPreviewAudio(true); };
      a.onEnded = this._pvEnded;
      fadeMusicIn(this.app, (this.app.settings.volumes?.music ?? 0.75) * 0.8, fade ? 1.2 : 0.6);
      this._pfKey = null;
    } catch (e) {
      console.warn('preview play failed', e);
      pv.playing = false;
    }
  }

  _stopPreview(keepStatus = false) {
    this._pvToken = (this._pvToken || 0) + 1;
    const a = this.app.audio;
    const pv = this._pv;
    if (pv && pv.playing && a.source === pv.src) a.stop();
    if (a.onEnded === this._pvEnded) a.onEnded = null;
    if (pv) restoreMusicVolume(this.app);
    this._pv = null;
    if (!keepStatus) { this._pvLoading = null; this._renderPreviewStatus(); }
    this._resetPreviewClock();
  }

  _renderPreviewStatus() {
    const el = this.sbAudio;
    if (!el) return;
    if (!this.previewOn) el.textContent = tr('♪ превью выкл.', '♪ preview off');
    else if (this._pvLoading && this._pvLoading === this.setId) el.textContent = tr('⌛ загрузка превью…', '⌛ loading preview…');
    else if (this._pv && this._pv.playing) el.textContent = tr('♪ играет превью', '♪ preview playing');
    else el.textContent = tr('♪ превью', '♪ preview');
  }

  // ---- launch panel: brain, mods, start ----------------------------------------------------------------

  _renderLaunch() {
    const app = this.app;
    const el = this.launchEl;
    if (!el) return;
    clear(el);
    const mode = this.mode;
    const brains = app.brains ? app.brains.list() : [];
    const needBrain = mode !== 'play';
    const noBrain = needBrain && (!brains.length || !app.brains.selected);

    const top = h('div.sel-launch-top');
    if (!needBrain) {
      top.append(icon('play', 32), h('div.sel-launch-text', h('b', tr('Ты играешь сам.', 'You play.')), h('span', tr('Мышь — целиться, клик по полю — захват курсора, Esc — пауза.', 'Mouse aims, click the field to lock the cursor, Esc pauses.'))));
    } else if (!brains.length) {
      top.append(icon('warning', 32), h('div.sel-launch-text',
        h('b', tr('Нет обученной МУХИ.', 'No trained МУХА yet.')),
        h('span', tr('Обучи свою в Лаборатории — это займёт пару минут.', 'Train one in the Lab — it only takes a few minutes.'))),
      button98(tr('Лаборатория', 'Lab'), () => { uiSfx(app); app.go('lab'); }, { iconName: 'lab' }));
    } else {
      const cur = brains.find((b) => b.id === app.brains.selected) || brains[0];
      const sel = h('select.sel-brain', {
        onchange: () => { uiSfx(app, 'ui', 0.3); app.brains.select(sel.value); },
      }, brains.map((b) => h('option', { value: b.id, selected: b.id === cur.id },
        `${b.title?.emoji || ''} ${brainName(b)} — ${titleName(b.title)} ★${(b.skill || 0).toFixed(1)}${b.kind === 'live' ? tr(' (твоя)', ' (yours)') : ''}`)));
      const hand = HAND_PRESETS[cur.hand];
      top.append(icon(mode === 'watch' ? 'watch' : 'versus', 32), h('div.sel-launch-text',
        h('label.sel-brain-row', h('span', mode === 'versus' ? tr('Соперник:', 'Opponent:') : tr('Играет:', 'Player:')), sel),
        h('span.dim', hand ? `${getLang() === 'en' ? hand.en : hand.ru} · ${tr('скорость', 'speed')} ${hand.maxSpeed}, ${tr('ускорение', 'accel')} ${hand.maxAccel}` : '')));
    }

    // mods
    const mods = app.settings.mods || (app.settings.mods = { speed: 1 });
    const saveMods = () => { app.saveSettings(); this._renderDetail(); this._pfKey = null; };
    const speedSel = h('select.sel-speed', {
      onchange: () => { mods.speed = Number(speedSel.value); uiSfx(app, 'ui', 0.3); saveMods(); },
    }, SPEEDS.map((v) => h('option', { value: v, selected: Math.abs((mods.speed || 1) - v) < 1e-6 }, `${v}×`)));
    const check = (key, label, hint) => {
      const input = h('input', { type: 'checkbox', checked: !!mods[key], onchange: () => { mods[key] = input.checked; uiSfx(app, 'ui', 0.3); saveMods(); } });
      return h('label.check', { title: hint }, input, h('span', label));
    };
    const modsBox = h('fieldset.groupbox.sel-mods', h('legend', tr('Моды', 'Mods')),
      h('label.sel-speed-row', h('span', tr('Скорость:', 'Speed:')), speedSel),
      check('noFail', 'No Fail', tr('Нельзя проиграть, даже если здоровье кончилось', 'You can’t fail even when health runs out')),
      check('hardRock', 'Hard Rock', tr('Сложнее: меньше хитбокс и окно попадания', 'Harder: smaller hitbox and hit window')),
      check('mirror', 'Mirror', tr('Карта отражена по горизонтали', 'The map is mirrored horizontally')));

    const label = mode === 'play' ? tr('Старт', 'Start') : mode === 'watch' ? tr('Смотреть', 'Watch') : tr('В бой!', 'Fight!');
    const start = button98(label, () => this._start(), { primary: true, disabled: !this.mapId || noBrain, iconName: mode === 'play' ? 'play' : mode, className: 'sel-start' });
    el.append(top, h('div.sel-launch-bottom', modsBox, h('div.sel-start-wrap', start, h('span.sel-start-hint', 'Enter'))));
  }

  _start(mode = this.mode) {
    const app = this.app;
    if (!this.mapId) return;
    if (mode !== 'play' && (!app.brains || !app.brains.list().length || !app.brains.selected)) {
      app.dialog({
        title: 'МУХА 98', icon: 'warning',
        text: tr('Пока нет ни одной обученной МУХИ.\nОбучи её в Лаборатории — и возвращайся.', 'There is no trained МУХА yet.\nTrain her in the Lab and come back.'),
        buttons: [{ label: tr('В лабораторию', 'Open the Lab'), value: 'lab', primary: true }, { label: tr('Отмена', 'Cancel'), value: null }],
      }).then((v) => { if (v === 'lab') app.go('lab'); });
      return;
    }
    if (mode !== this.mode) this._setMode(mode);
    uiSfx(app, 'hit', 0.6);
    app.go('game', { mapId: this.mapId, mode, brainId: app.brains ? app.brains.selected : null, mods: { ...(app.settings.mods || {}) } });
  }

  async _deleteSet(set) {
    const app = this.app;
    if (set.source === 'builtin') return;
    const ok = await confirmDialog(app, {
      title: tr('Удаление набора карт', 'Delete mapset'),
      text: tr(`Удалить «${set.title}» (${set.maps.length} ${plural(set.maps.length, 'карта', 'карты', 'карт')}) из этого браузера?\nРекорды останутся.`, `Delete “${set.title}” (${set.maps.length} maps) from this browser?\nYour scores stay.`),
      ok: tr('Удалить', 'Delete'), cancel: tr('Отмена', 'Cancel'), danger: true,
    });
    if (!ok) return;
    try {
      if (this._pv && this._pv.setId === set.id) this._stopPreview();
      await app.library.removeSet(set.id);
      app.toast(tr(`Удалено: ${set.title}`, `Deleted: ${set.title}`), 'success');
    } catch (e) {
      app.dialog({ title: 'МУХА 98', icon: 'error', text: tr('Не удалось удалить:\n', 'Delete failed:\n') + (e.message || e) });
    }
  }

  _back() {
    const app = this.app;
    // never step "back" into a finished run: skip game / results entries
    while (app.history.length && ['game', 'results', 'select'].includes(app.history[app.history.length - 1].name)) app.history.pop();
    app.back('menu');
  }

  // ---- keyboard --------------------------------------------------------------------------------------

  keydown(e) {
    if (isModalOpen(this.app)) return false;
    const inSearch = e.target === this.searchInput;
    const tag = e.target?.tagName;
    const k = e.key;
    if (tag === 'SELECT' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(k)) return false;
    if (k === 'ArrowDown' || k === 'ArrowUp') { this._step(k === 'ArrowDown' ? 1 : -1); return true; }
    if (k === 'PageDown' || k === 'PageUp') { this._step(k === 'PageDown' ? 10 : -10); return true; }
    if (k === 'Home' && !inSearch) { this._step(-1e6); return true; }
    if (k === 'End' && !inSearch) { this._step(1e6); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (inSearch && this.searchInput.value) return false;
      this._stepDiff(k === 'ArrowRight' ? 1 : -1);
      return true;
    }
    if (k === 'Enter') {
      if (tag === 'BUTTON' || (tag === 'INPUT' && !inSearch)) return false;
      this._start();
      return true;
    }
    if (k === 'Delete' && !inSearch) { const s = this._set(); if (s && s.source !== 'builtin') this._deleteSet(s); return true; }
    if (k === 'Escape') {
      if (inSearch && this.searchInput.value) { this.searchInput.value = ''; this.query = ''; this._renderList(); return true; }
      if (inSearch) { this.searchInput.blur(); return true; }
      this._back();
      return true;
    }
    if (!inSearch && !e.ctrlKey && !e.metaKey && !e.altKey && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      if (k === '1' || k === '2' || k === '3') { uiSfx(this.app); this._setMode(MODES[+k - 1]); return true; }
      if (k.length === 1 && /\S/.test(k)) {
        this.searchInput.focus();   // type-to-search: the character lands in the field
        return false;
      }
    }
    return false;
  }
}
