import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Judge, NOTE_HIT, NOTE_MISS } from '../src/core/judge.js';
import { packNotes, computeStars } from '../src/core/map.js';
import { DEFAULT_SETTINGS, gradeFor } from '../src/core/constants.js';
import { syntheticMap, placeNotes } from '../src/maps/patterns.js';
import { MLP } from '../src/ai/nn.js';
import { runEpisode, HAND_PRESETS, DEFAULT_ARCH } from '../src/ai/agent.js';
import { AIDriver } from '../src/ai/driver.js';
import { RNG } from '../src/core/rng.js';
import { skillFromLevels, titleFor } from '../src/ai/trainer.js';

test('judge: hit only after the note time, within the one-sided window', () => {
  const p = packNotes([{ t: 1, x: 0, y: 0 }]);
  const j = new Judge(p);
  j.update(0.99, 0, 0); // early: not hittable yet
  assert.equal(j.hits, 0);
  j.update(1.0, 0, 0);
  assert.equal(j.state[0], NOTE_HIT);
  assert.equal(j.score, DEFAULT_SETTINGS.scorePerNote);
});

test('judge: square hitbox of 1.1375 and miss after 55 ms', () => {
  const p = packNotes([{ t: 1, x: 1, y: 1 }, { t: 2, x: 1, y: 1 }]);
  const j = new Judge(p);
  j.update(1.01, 1 + 0.568, 1 - 0.568); // inside corner
  assert.equal(j.state[0], NOTE_HIT);
  j.update(2.01, 1 + 0.57, 1); // just outside
  assert.equal(j.state[1], 0);
  j.update(2.056, 1 + 0.57, 1);
  assert.equal(j.state[1], NOTE_MISS);
  assert.equal(j.health, DEFAULT_SETTINGS.healthMax - 1);
});

test('judge: multiplier rises every 10 hits, drops by one on a miss, fail at 0 hp', () => {
  const notes = [];
  for (let i = 0; i < 25; i++) notes.push({ t: 1 + i * 0.2, x: 1, y: 1 });
  for (let i = 0; i < 6; i++) notes.push({ t: 10 + i * 0.2, x: 0, y: 0 });
  const j = new Judge(packNotes(notes));
  for (let i = 0; i < 25; i++) j.update(1 + i * 0.2, 1, 1);
  assert.equal(j.multiplier, 3);
  j.update(20, 2, 2); // miss all remaining
  assert.equal(j.misses, 6);
  assert.equal(j.multiplier, 1);
  assert.ok(j.failed);
});

test('grades follow SS+ thresholds', () => {
  assert.equal(gradeFor(1).name, 'SS');
  assert.equal(gradeFor(0.985).name, 'S');
  assert.equal(gradeFor(0.95).name, 'A');
  assert.equal(gradeFor(0.5).name, 'F');
  assert.equal(gradeFor(1, true).name, 'F');
});

test('synthetic maps get harder with level (stars monotone on average)', () => {
  const avg = (L) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += computeStars(syntheticMap(L, 1000 + k * 13 + L, 30));
    return s / 4;
  };
  let prev = -1;
  for (const L of [0, 3, 6, 9, 12, 15]) {
    const a = avg(L);
    assert.ok(a > prev, `level ${L}: ${a} should exceed ${prev}`);
    prev = a;
  }
});

test('placeNotes keeps notes on the playfield and preserves times', () => {
  const times = Array.from({ length: 200 }, (_, i) => ({ t: 1 + i * 0.12, strength: (i % 4) / 4 }));
  const notes = placeNotes(times, { stars: 8, seed: 5 });
  assert.equal(notes.length, times.length);
  for (let i = 0; i < notes.length; i++) {
    assert.equal(notes[i].t, times[i].t);
    assert.ok(notes[i].x >= 0 && notes[i].x <= 2 && notes[i].y >= 0 && notes[i].y <= 2);
  }
});

test('real-time AIDriver plays exactly like the headless training episode', () => {
  const rng = new RNG(3);
  const net = new MLP(DEFAULT_ARCH).init(() => rng.gauss(), 1);
  const packed = packNotes(syntheticMap(4, 77, 12));
  const r = runEpisode(net, packed, { hand: HAND_PRESETS.pro });
  const judge = new Judge(packed, { ...DEFAULT_SETTINGS, noFail: true });
  const drv = new AIDriver({ arch: DEFAULT_ARCH, params: net.params, hand: HAND_PRESETS.pro }, judge, DEFAULT_SETTINGS);
  const start = packed.t[0] - 1.0;
  drv.reset(start);
  // render at an irregular frame rate
  let t = start;
  while (t < packed.t[packed.n - 1] + 0.2) { t += 0.007 + (Math.sin(t * 50) + 1) * 0.006; drv.advanceTo(t); }
  assert.equal(judge.hits, r.hits);
  assert.equal(judge.misses, r.misses);
});

test('skill metric forgives one dip and titles are ordered', () => {
  const mk = (a) => a.map((acc, level) => ({ level, acc: acc / 100 }));
  assert.equal(skillFromLevels(mk(Array(21).fill(100))), 20.5);
  assert.equal(skillFromLevels(mk(Array(21).fill(10))), 0);
  assert.ok(skillFromLevels(mk([85, 95, 95, 95, 60, 50, 40])) > 3);
  assert.equal(titleFor(0).ru, 'Личинка');
  assert.equal(titleFor(20.5).ru, 'Абсолют');
});
