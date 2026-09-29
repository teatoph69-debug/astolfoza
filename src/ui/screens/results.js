// «Результаты» — dialog-like results window: grade letter in a sunken box, score count-up, stats,
// a timeline (hits / misses / health) and an aim heatmap (cursor offset of every hit inside the
// hitbox) drawn System-Monitor style on black; versus mode: winner banner + comparison table.
//
// params: { mapId, mode, player: RunResult|null, ai: RunResult|null, brainName, brainSkill?, replay }
// RunResult = { hits, misses, total, accuracy, score, maxCombo, failed, fullCombo, grade:{name,color},
//               notes:[{t, hit, dx, dy}], health:[[t, 0..1]], duration }

import { Screen } from '../app.js';
import { h, clear, hiDPICanvas } from '../dom.js';
import { tr, fmtNum, fmtPct } from '../i18n.js';
import { local } from '../store.js';
import { icon } from '../icons.js';
import { button98 } from '../win98.js';
import { gradeFor, DEFAULT_SETTINGS } from '../../core/constants.js';
import { formatTime } from '../../core/map.js';
import { uiSfx, goBackTo, isModalOpen } from './menu.js';

// System-Monitor palette (inside black canvases only)
const C = { bg: '#000000', grid: '#008040', text: '#00ff00', hit: '#00ff00', miss: '#ff0000', player: '#ffff00', ai: '#00ffff', box: '#c0c0c0' };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Fill in anything a RunResult may be missing so the screen never crashes on partial data. */
function normRun(r, fallbackDuration) {
  if (!r) return null;
  const notes = Array.isArray(r.notes) ? r.notes : [];
  const hits = r.hits ?? notes.filter((n) => n.hit).length;
  const misses = r.misses ?? notes.filter((n) => !n.hit).length;
  const judged = hits + misses;
  const accuracy = r.accuracy ?? (judged ? hits / judged : 0);
  const failed = !!r.failed;
  const grade = r.grade && r.grade.name ? r.grade : gradeFor(accuracy, failed);
  return {
    ...r, notes, hits, misses, accuracy, failed, grade,
    total: r.total ?? judged,
    score: r.score ?? 0,
    maxCombo: r.maxCombo ?? 0,
    fullCombo: r.fullCombo ?? (misses === 0 && !failed && judged > 0),
    health: Array.isArray(r.health) ? r.health : [],
    duration: r.duration || fallbackDuration || (notes.length ? notes[notes.length - 1].t + 2 : 1),
  };
}

/** Aim statistics from hit offsets (grid units). */
function aimStats(run) {
  const hits = run.notes.filter((n) => n.hit && Number.isFinite(n.dx) && Number.isFinite(n.dy));
  if (!hits.length) return null;
  let sx = 0, sy = 0;
  for (const n of hits) { sx += n.dx; sy += n.dy; }
  const mx = sx / hits.length, my = sy / hits.length;
  let s2 = 0;
  for (const n of hits) s2 += (n.dx - mx) ** 2 + (n.dy - my) ** 2;
  return { n: hits.length, mx, my, spread: Math.sqrt(s2 / hits.length) };
}

function biasText(a) {
  if (!a) return tr('Нет попаданий — нечего анализировать.', 'No hits — nothing to analyse.');
  const parts = [];
  if (Math.abs(a.mx) > 0.035) parts.push(a.mx > 0 ? tr('правее', 'to the right') : tr('левее', 'to the left'));
  if (Math.abs(a.my) > 0.035) parts.push(a.my > 0 ? tr('ниже', 'low') : tr('выше', 'high'));
  if (!parts.length) return tr('Прицел точно по центру нот — отлично!', 'Aim is dead-centre on the notes — great!');
  return tr(`В среднем курсор чуть ${parts.join(' и ')} центра нот.`, `On average the cursor sits slightly ${parts.join(' and ')} of note centres.`);
}

export function winnerOf(p, a) {
  if (p.failed !== a.failed) return p.failed ? 'ai' : 'player';
  if (p.score !== a.score) return p.score > a.score ? 'player' : 'ai';
  if (Math.abs(p.accuracy - a.accuracy) > 1e-9) return p.accuracy > a.accuracy ? 'player' : 'ai';
  return 'draw';
}

export class ResultsScreen extends Screen {
  mount() {
    this.root = h('div.res-root');
    this.el.appendChild(this.root);
    this._anims = [];
  }

  title() { return tr('Результаты', 'Results'); }

  statusbar() {
    this.sbMap = h('div.status-field');
    this.sbBest = h('div.status-field.fit');
    return [this.sbMap, this.sbBest];
  }

  show(params = {}) {
    this.params = params;
    this._cancelAnims();
    const app = this.app;
    const map = app.library?.getMap(params.mapId) || null;
    this.map = map;
    this.set = map ? app.library.getSet(map.setId) : null;
    const player = normRun(params.player, map?.duration);
    const ai = normRun(params.ai, map?.duration);
    this.player = player;
    this.ai = ai;
    this.mode = params.mode || (player && ai ? 'versus' : ai ? 'watch' : 'play');
    this.replay = params.replay || { mapId: params.mapId, mode: this.mode, brainId: app.brains?.selected, mods: { ...(app.settings.mods || {}) } };
    this.mods = this.replay.mods || {};

    // personal best: player runs only, failed runs don't count; recorded once per result object
    this.prevBest = local.get('best.' + params.mapId, null);
    this.newRecord = false;
    if (player && !player.failed && params.mapId) {
      if (params._record === undefined) {
        params._prevBest = this.prevBest;
        params._record = !this.prevBest || player.score > (this.prevBest.score || 0);
        if (params._record) {
          local.set('best.' + params.mapId, {
            score: player.score, accuracy: player.accuracy, grade: { name: player.grade.name, color: player.grade.color },
            maxCombo: player.maxCombo, fullCombo: player.fullCombo, mods: this.mods, date: Date.now(),
          });
          params._toast = true;
        }
      }
      this.prevBest = params._prevBest ?? null;
      this.newRecord = !!params._record;
    }
    this.setTitle(`${tr('Результаты', 'Results')} — ${map ? map.title : '?'}`);
    this.build();
    if (params._toast) {
      params._toast = false;
      const d = this.prevBest ? ` (+${fmtNum(player.score - (this.prevBest.score || 0))})` : '';
      this._anims.push(setTimeout(() => app.toast(tr(`Новый рекорд! ${fmtNum(player.score)}${d}`, `New record! ${fmtNum(player.score)}${d}`), 'level', 5000), 700));
    }
  }

  hide() { this._cancelAnims(); }

  resize() { this._drawCharts(); }

  _cancelAnims() {
    for (const id of this._anims) { cancelAnimationFrame(id); clearTimeout(id); }
    this._anims = [];
  }

  // ---- DOM -------------------------------------------------------------------------------------

  build() {
    const app = this.app;
    const { player, ai, map, mode } = this;
    const main = player || ai;
    const mods = [];
    if (this.mods.speed && this.mods.speed !== 1) mods.push(`${this.mods.speed}×`);
    if (this.mods.noFail) mods.push('No Fail');
    if (this.mods.hardRock) mods.push('Hard Rock');
    if (this.mods.mirror) mods.push('Mirror');
    const modeText = mode === 'versus' ? tr('Против МУХИ', 'Versus МУХА') : mode === 'watch' ? tr('Играла МУХА', 'МУХА played') : tr('Твоя игра', 'Your run');

    const top = h('div.res-top',
      icon(mode === 'versus' ? 'versus' : mode === 'watch' ? 'watch' : 'trophy', 32),
      h('div.res-top-text',
        h('div.res-top-title', map ? `${map.title} — ${map.difficultyName || '?'}` : tr('Карта', 'Map')),
        h('div.res-top-sub', [map?.artist, map ? `★${(map.stars || 0).toFixed(2)}` : null, modeText, mods.length ? `${tr('моды', 'mods')}: ${mods.join(', ')}` : null].filter(Boolean).join(' · '))));

    let body;
    if (mode === 'versus' && player && ai) body = this._versus(player, ai);
    else if (main) body = this._single(main, !player);
    else body = h('div.res-empty.sunken', tr('Нет данных о забеге.', 'No run data.'));

    const buttons = h('div.res-buttons',
      button98(tr('Повторить', 'Retry'), () => { uiSfx(app); this._retry(); }, { primary: true, iconName: 'play' }),
      mode === 'watch'
        ? button98(tr('Сыграть самому', 'Play it yourself'), () => { uiSfx(app); this._play(); }, { iconName: 'play' })
        : button98(tr('Смотреть МУХУ на этой карте', 'Watch МУХА on this map'), () => { uiSfx(app); this._watch(); }, { iconName: 'watch' }),
      button98(tr('К выбору карты', 'Back to maps'), () => { uiSfx(app); this._toSelect(); }, { iconName: 'folder' }));

    clear(this.root).append(top, body, buttons);
    this.root.scrollTop = 0;

    if (this.sbMap) this.sbMap.textContent = map ? `${map.artist ? map.artist + ' — ' : ''}${map.title} [${map.difficultyName || '?'}]` : '';
    if (this.sbBest) {
      const b = local.get('best.' + this.params.mapId, null);
      this.sbBest.textContent = b ? `${tr('Рекорд', 'Best')}: ${fmtNum(b.score || 0)} (${b.grade?.name || '?'})` : tr('Рекорда нет', 'No record');
    }
    requestAnimationFrame(() => this._drawCharts());
    this._startCounters();
    if (main && !main.failed && (this.newRecord || ['SS', 'S'].includes(main.grade.name))) this._anims.push(setTimeout(() => uiSfx(app, 'levelup', 0.5), 500));
  }

  _gradeBox(run, size = 'big') {
    return h(`div.res-grade.sunken.${size}.g-${run.grade.name}`, { style: `--g:${run.grade.color || '#000'}` },
      h('span.res-grade-letter.display', run.grade.name));
  }

  _badges(run, isAi) {
    const out = [];
    if (run.failed) out.push(h('span.chip.res-chip-fail', 'FAILED'));
    else if (run.fullCombo) out.push(h('span.chip.res-chip-fc', 'FULL COMBO'));
    if (!isAi && this.newRecord) out.push(h('span.chip.res-chip-rec', icon('trophy', 16), tr('Новый рекорд!', 'New record!')));
    return out;
  }

  _single(run, isAi) {
    const aim = aimStats(run);
    let bestLine = null;
    if (!isAi) {
      if (this.newRecord && this.prevBest) bestLine = h('div.res-best', tr('Прошлый рекорд: ', 'Previous best: '), fmtNum(this.prevBest.score), h('b', ` (+${fmtNum(run.score - this.prevBest.score)})`));
      else if (this.prevBest && !this.newRecord) bestLine = h('div.res-best', tr('Рекорд: ', 'Best: '), fmtNum(this.prevBest.score), ` · ${this.prevBest.grade?.name || ''} · ${fmtPct(this.prevBest.accuracy || 0)}`);
      else if (run.failed) bestLine = h('div.res-best', tr('Проваленные забеги не идут в рекорды.', 'Failed runs don’t count as records.'));
    }
    const who = isAi ? h('div.res-who', icon('fly', 16), h('b', this.params.brainName || 'МУХА'), this.params.brainSkill != null ? ` ★${Number(this.params.brainSkill).toFixed(1)}` : '') : null;
    const rows = [
      [tr('Попадания', 'Hits'), `${fmtNum(run.hits)} / ${fmtNum(run.total)}`],
      [tr('Промахи', 'Misses'), fmtNum(run.misses)],
      [tr('Точность', 'Accuracy'), fmtPct(run.accuracy)],
      [tr('Макс. комбо', 'Max combo'), fmtNum(run.maxCombo) + '×'],
      [tr('Разброс прицела', 'Aim spread'), aim ? `±${aim.spread.toFixed(3)} ${tr('клетки', 'cells')}` : '—'],
      [tr('Смещение', 'Offset'), aim ? `x ${aim.mx >= 0 ? '+' : ''}${aim.mx.toFixed(3)} · y ${aim.my >= 0 ? '+' : ''}${aim.my.toFixed(3)}` : '—'],
    ];
    const grid = h('div.res-grid',
      h('fieldset.groupbox.res-grade-box', h('legend', tr('Оценка', 'Grade')), this._gradeBox(run), h('div.res-badges', this._badges(run, isAi))),
      h('div.res-col',
        h('fieldset.groupbox', h('legend', tr('Счёт', 'Score')),
          who,
          h('div.res-score.display', h('span.res-count', { dataset: { to: run.score, kind: 'int' } }, '0')),
          h('div.res-acc', h('span.display.res-count', { dataset: { to: run.accuracy, kind: 'pct' } }, '0.00%'), h('span', tr(' точность', ' accuracy'))),
          bestLine),
        h('fieldset.groupbox', h('legend', tr('Статистика', 'Statistics')),
          h('table.res-table', h('tbody', rows.map(([k, v]) => h('tr', h('th', k), h('td', v))))))));
    const charts = this._charts([{ run, color: isAi ? C.ai : C.player, label: isAi ? 'МУХА' : tr('Ты', 'You') }], [aim]);
    return h('div.res-body', grid, charts);
  }

  _versus(p, a) {
    const w = winnerOf(p, a);
    const brain = this.params.brainName || 'МУХА';
    const banner = h(`div.res-banner.sunken.w-${w}`,
      icon(w === 'player' ? 'trophy' : w === 'ai' ? 'fly' : 'info', 32),
      h('div.res-banner-text',
        h('div.res-banner-title.display', w === 'player' ? tr('Ты победил МУХУ!', 'You beat МУХА!') : w === 'ai' ? tr('МУХА победила', 'МУХА wins') : tr('Ничья', 'Draw')),
        h('div', w === 'player'
          ? tr('Нейросеть повержена. Пора её подучить в Лаборатории.', 'The network is beaten. Time to train it harder in the Lab.')
          : w === 'ai' ? tr('Нейросеть оказалась точнее. Реванш?', 'The network aimed better. Rematch?')
            : tr('Идеально поровну — редкость!', 'Perfectly even — that’s rare!'))));
    const sign = (v, fmt) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v));
    const rows = [
      [tr('Оценка', 'Grade'), p.grade.name, a.grade.name, ''],
      [tr('Очки', 'Score'), fmtNum(p.score), fmtNum(a.score), sign(p.score - a.score, fmtNum)],
      [tr('Точность', 'Accuracy'), fmtPct(p.accuracy), fmtPct(a.accuracy), sign(Math.round((p.accuracy - a.accuracy) * 10000) / 100, (x) => x.toFixed(2) + '%')],
      [tr('Попадания', 'Hits'), fmtNum(p.hits), fmtNum(a.hits), sign(p.hits - a.hits, fmtNum)],
      [tr('Промахи', 'Misses'), fmtNum(p.misses), fmtNum(a.misses), sign(p.misses - a.misses, fmtNum)],
      [tr('Макс. комбо', 'Max combo'), fmtNum(p.maxCombo) + '×', fmtNum(a.maxCombo) + '×', sign(p.maxCombo - a.maxCombo, fmtNum)],
      [tr('Статус', 'Status'), p.failed ? 'FAILED' : p.fullCombo ? 'FC' : '—', a.failed ? 'FAILED' : a.fullCombo ? 'FC' : '—', ''],
    ];
    const table = h('div.listview98.res-vs-table', h('table',
      h('thead', h('tr', h('th', ''), h(`th.num${w === 'player' ? '.res-win' : ''}`, tr('Ты', 'You') + (w === 'player' ? ' 👑' : '')), h(`th.num${w === 'ai' ? '.res-win' : ''}`, brain + (w === 'ai' ? ' 👑' : '')), h('th.num', tr('Разница', 'Delta')))),
      h('tbody', rows.map((r) => h('tr', h('td', r[0]), h('td.num', r[1]), h('td.num', r[2]), h('td.num', r[3]))))));
    const grades = h('div.res-vs-grades',
      h('fieldset.groupbox', h('legend', tr('Ты', 'You')), this._gradeBox(p, 'mid'),
        h('div.res-score.display.mid', h('span.res-count', { dataset: { to: p.score, kind: 'int' } }, '0')), h('div.res-badges', this._badges(p, false))),
      h('fieldset.groupbox', h('legend', brain), this._gradeBox(a, 'mid'),
        h('div.res-score.display.mid', h('span.res-count', { dataset: { to: a.score, kind: 'int' } }, '0')), h('div.res-badges', this._badges(a, true))));
    const grid = h('div.res-grid.vs', grades, h('fieldset.groupbox.res-vs-box', h('legend', tr('Сравнение', 'Comparison')), banner, table));
    const charts = this._charts([
      { run: p, color: C.player, label: tr('Ты', 'You') },
      { run: a, color: C.ai, label: 'МУХА' },
    ], [aimStats(p), aimStats(a)]);
    return h('div.res-body', grid, charts);
  }

  _charts(runs, aims) {
    this._runs = runs;
    this.tlCanvas = h('canvas.res-canvas');
    this.hmCanvas = h('canvas.res-canvas');
    const legend = h('div.res-legend',
      runs.map((r) => h('span', h('i', { style: `background:${r.color}` }), `${r.label} — ${tr('здоровье', 'health')}`)),
      h('span', h('i', { style: `background:${C.hit}` }), tr('попадание', 'hit')),
      h('span', h('i', { style: `background:${C.miss}` }), tr('промах', 'miss')));
    const aimText = runs.map((r, i) => h('div.res-aim-line', runs.length > 1 ? h('b', r.label + ': ') : null, biasText(aims[i])));
    return h('div.res-charts',
      h('fieldset.groupbox.res-tl', h('legend', tr('Ход игры', 'Timeline')), h('div.sunken.black.res-tl-box', this.tlCanvas), legend),
      h('fieldset.groupbox.res-hm', h('legend', tr('Карта прицела', 'Aim heatmap')), h('div.sunken.black.res-hm-box', this.hmCanvas), aimText));
  }

  // ---- charts ------------------------------------------------------------------------------------

  _drawCharts() {
    if (!this._runs || !this.tlCanvas || !this.tlCanvas.isConnected) return;
    this._drawTimeline();
    this._drawHeatmap();
  }

  _grid(ctx, w, hh, step = 12) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0.5; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
    for (let y = hh - 0.5; y > 0; y -= step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  _drawTimeline() {
    const c = hiDPICanvas(this.tlCanvas);
    const { ctx, w, h: H } = c;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, H);
    const runs = this._runs;
    const dur = Math.max(1, ...runs.map((r) => r.run.duration || 1));
    const padB = 12;
    this._grid(ctx, w, H - padB);
    const X = (t) => clamp(t / dur, 0, 1) * (w - 2) + 1;
    const lanes = runs.length;
    const laneH = (H - padB) / lanes;
    ctx.font = '10px "Lucida Console", "Courier New", monospace';
    runs.forEach((r, li) => {
      const top = li * laneH + 2, bot = (li + 1) * laneH - 2;
      const hh = bot - top;
      // misses: red full-height bars
      ctx.fillStyle = C.miss;
      for (const n of r.run.notes) if (!n.hit) ctx.fillRect(Math.round(X(n.t)), top + 10, 1, hh - 10);
      // hits: green ticks at the bottom
      ctx.fillStyle = C.hit;
      for (const n of r.run.notes) if (n.hit) ctx.fillRect(Math.round(X(n.t)), bot - 4, 1, 4);
      // health line
      const hp = r.run.health;
      if (hp.length) {
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        hp.forEach(([t, v], i) => { const x = X(t), y = bot - 6 - clamp(v, 0, 1) * (hh - 18); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      }
      if (r.run.failed && r.run.notes.length) {
        const x = X(r.run.notes[r.run.notes.length - 1].t);
        ctx.fillStyle = C.miss;
        ctx.textAlign = x > w - 40 ? 'right' : 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('FAIL', x + (x > w - 40 ? -3 : 3), top + 1);
      }
      if (lanes > 1) {
        ctx.fillStyle = r.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(r.label, 3, top + 1);
      }
    });
    ctx.fillStyle = C.text;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText('0:00', 2, H);
    ctx.textAlign = 'center';
    ctx.fillText(formatTime(dur / 2), w / 2, H);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(dur), w - 2, H);
  }

  _drawHeatmap() {
    const c = hiDPICanvas(this.hmCanvas);
    const { ctx, w, h: H } = c;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, H);
    this._grid(ctx, w, H, 16);
    const size = Math.min(w, H);
    const cx = w / 2, cy = H / 2;
    const hitbox = (DEFAULT_SETTINGS.hitbox || 1.14) * (this.mods.hardRock ? 0.9 : 1);
    const range = hitbox * 0.5 * 1.45;
    const k = (size / 2 - 6) / range;
    const hb = hitbox * k;
    const ns = (DEFAULT_SETTINGS.noteSize || 0.875) * k;
    ctx.fillStyle = '#101010';
    ctx.fillRect(Math.round(cx - ns / 2), Math.round(cy - ns / 2), Math.round(ns), Math.round(ns));
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = C.box;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(cx - hb / 2) + 0.5, Math.round(cy - hb / 2) + 0.5, Math.round(hb), Math.round(hb));
    ctx.setLineDash([]);
    ctx.strokeStyle = '#00a050';
    ctx.beginPath(); ctx.moveTo(cx - hb / 2, Math.round(cy) + 0.5); ctx.lineTo(cx + hb / 2, Math.round(cy) + 0.5); ctx.moveTo(Math.round(cx) + 0.5, cy - hb / 2); ctx.lineTo(Math.round(cx) + 0.5, cy + hb / 2); ctx.stroke();
    // hits
    for (const r of this._runs) {
      const hits = r.run.notes.filter((n) => n.hit && Number.isFinite(n.dx));
      ctx.globalAlpha = clamp(14 / Math.sqrt(hits.length + 1), 0.12, 0.7);
      ctx.fillStyle = this._runs.length > 1 ? r.color : C.hit;
      for (const n of hits) {
        const x = cx + clamp(n.dx, -range, range) * k, y = cy + clamp(n.dy, -range, range) * k;
        ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
      }
    }
    ctx.globalAlpha = 1;
    // misses near the box
    ctx.strokeStyle = C.miss;
    for (const r of this._runs) {
      for (const n of r.run.notes) {
        if (n.hit || !Number.isFinite(n.dx) || Math.abs(n.dx) > range || Math.abs(n.dy) > range) continue;
        const x = Math.round(cx + n.dx * k) + 0.5, y = Math.round(cy + n.dy * k) + 0.5;
        ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke();
      }
    }
    // mean offset marker + spread circle
    for (const r of this._runs) {
      const s = aimStats(r.run);
      if (!s) continue;
      const x = cx + s.mx * k, y = cy + s.my * k;
      ctx.strokeStyle = this._runs.length > 1 ? r.color : C.player;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, Math.max(4, s.spread * k), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 5, 5);
    }
  }

  // ---- count-up animation ---------------------------------------------------------------------------

  _startCounters() {
    const els = Array.from(this.root.querySelectorAll('.res-count'));
    const t0 = performance.now() + 200;
    const dur = 1100;
    const step = (now) => {
      const u = clamp((now - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - u, 3);
      for (const el of els) {
        const to = Number(el.dataset.to) || 0;
        el.textContent = el.dataset.kind === 'pct' ? (to * e * 100).toFixed(2) + '%' : fmtNum(to * e);
      }
      if (u < 1) this._anims.push(requestAnimationFrame(step));
    };
    this._anims.push(requestAnimationFrame(step));
  }

  // ---- navigation ----------------------------------------------------------------------------------

  _retry() { this.app.go('game', { ...this.replay }, { replace: true }); }

  _watch() { this.app.go('game', { ...this.replay, mode: 'watch', brainId: this.replay.brainId || this.app.brains?.selected }, { replace: true }); }

  _play() { this.app.go('game', { ...this.replay, mode: 'play' }, { replace: true }); }

  _toSelect() {
    goBackTo(this.app, 'select', { mode: this.mode === 'versus' || this.mode === 'watch' ? this.mode : 'play', focusSet: this.map?.setId });
  }

  keydown(e) {
    if (isModalOpen(this.app)) return false;
    const k = e.key;
    if (k === 'Escape' || k === 'Backspace') { this._toSelect(); return true; }
    if (k === 'Enter' && e.target?.tagName === 'BUTTON') return false;
    if (k === 'Enter' || k === 'r' || k === 'R' || k === 'к' || k === 'К' || k === '`' || k === 'ё') { this._retry(); return true; }
    if (k === 'w' || k === 'W' || k === 'ц' || k === 'Ц') { this.mode === 'watch' ? this._play() : this._watch(); return true; }
    return false;
  }
}
