#!/usr/bin/env node
// Packs trained checkpoints (tools/train.mjs output) into assets/brains.json — the pretrained
// brains shipped inside the game. Each brain is re-benchmarked so its ★ skill is exact.
//
//   node tools/export-brains.mjs

import fs from 'node:fs';
import { benchmark, titleFor } from '../src/ai/trainer.js';
import { HAND_PRESETS } from '../src/ai/agent.js';
import { paramsToBase64 } from '../src/ai/nn.js';

const CK = 'checkpoints';
const read = (f) => (fs.existsSync(`${CK}/${f}`) ? JSON.parse(fs.readFileSync(`${CK}/${f}`, 'utf8')) : null);

// [file, which params, id, ru name, en name]
const PICKS = [
  ['pro.rank3.json', 'champion', 'rookie', 'МУХА-новичок', 'Rookie МУХА'],
  ['pro.rank7.json', 'champion', 'pro-mid', 'Середнячок', 'Midfielder'],
  ['human.json', 'champion', 'human', 'МУХА · человеческая рука', 'МУХА · human hand'],
  ['pro.json', 'champion', 'pro', 'МУХА · рука топ-игрока', 'МУХА · pro hand'],
  ['cyber.json', 'champion', 'cyber', 'МУХА · кибер-рука', 'МУХА · cyber hand'],
];

const out = [];
for (const [file, key, id, name, en] of PICKS) {
  const ck = read(file);
  if (!ck) { console.warn('skip (missing)', file); continue; }
  const params = Float32Array.from(ck[key] || ck.theta);
  const hand = HAND_PRESETS[ck.hand] || HAND_PRESETS.pro;
  const b = benchmark(ck.arch, params, hand);
  const t = titleFor(b.skill);
  console.log(`${id.padEnd(8)} gen ${String(ck.gen).padStart(5)}  hand ${hand.id.padEnd(5)}  skill ★${b.skill.toFixed(2)}  ${t.ru}  [${b.perLevel.map((p) => Math.round(p.acc * 100)).join('/')}]`);
  out.push({ id, name, en, hand: hand.id, arch: ck.arch, gen: ck.gen, skill: +b.skill.toFixed(3), perLevel: b.perLevel.map((p) => +p.acc.toFixed(3)), params: paramsToBase64(params) });
}
out.sort((a, b) => a.skill - b.skill);
fs.writeFileSync('assets/brains.json', JSON.stringify(out, null, 1));
console.log(`wrote assets/brains.json (${out.length} brains, ${(fs.statSync('assets/brains.json').size / 1024).toFixed(0)} KB)`);
