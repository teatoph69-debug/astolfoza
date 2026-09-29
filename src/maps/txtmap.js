// Legacy Sound Space (Roblox) text maps: "<audioId>,x|y|ms,x|y|ms,..." (one line).
//
// The text format uses INVERTED axes compared to .sspm / our grid (verified in SS+ Song.gd loadRawData,
// the Sound Space Quantum Editor renderer and the Rhythia wiki): x = 0 is the RIGHT column and y = 0 is
// the BOTTOM row. SS+ converts with x = 2 − x_txt, y = 2 − y_txt, and so do we. Times are milliseconds.

import { formatError } from './sspm.js';

/**
 * @param {string} text
 * @returns {{ audioId: string, notes: {t:number,x:number,y:number}[], skipped: number }}
 */
export function parseTxtMap(text) {
  if (typeof text !== 'string') throw formatError('Ожидался текст карты', 'Expected map text');
  const src = text.replace(/^﻿/, '').trim();
  if (!src) throw formatError('Файл карты пустой', 'The map file is empty');
  const tokens = src.split(',');
  let audioId = '';
  let start = 0;
  if (!tokens[0].includes('|')) {
    audioId = tokens[0].trim().replace(/^rbxassetid:\/\//i, '');
    start = 1;
  }
  const notes = [];
  let skipped = 0;
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i].trim();
    if (!tok) continue;
    const parts = tok.split('|');
    if (parts.length !== 3) { skipped++; continue; }
    const xt = parseNum(parts[0]), yt = parseNum(parts[1]), ms = parseNum(parts[2]);
    if (!Number.isFinite(xt) || !Number.isFinite(yt) || !Number.isFinite(ms) || ms < -60000) { skipped++; continue; }
    notes.push({ t: ms / 1000, x: fix(2 - xt), y: fix(2 - yt) });
  }
  if (!notes.length || skipped > 3 * notes.length) {
    throw formatError('Это не похоже на текстовую карту Sound Space (ожидается «id,x|y|мс,…»)',
      'This does not look like a Sound Space text map (expected "id,x|y|ms,...")');
  }
  notes.sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x);
  return { audioId, notes, skipped };
}

/** Cheap check used for content sniffing (e.g. a map saved with a wrong extension). */
export function looksLikeTxtMap(text) {
  const head = String(text).replace(/^﻿/, '').trimStart().slice(0, 400);
  return /^[^,|\n]*,\s*-?[\d.]+\|-?[\d.]+\|-?[\d.]+/.test(head);
}

function parseNum(s) {
  const t = s.trim();
  return t === '' ? NaN : Number(t);
}

// 2 − 0.1 = 1.9 exactly, but 2 − 2.1525886 must not turn into -0.15258860000000018
function fix(v) { return Math.round(v * 1e6) / 1e6 + 0; }
