// Tests for the browser training plumbing (src/ai/worker.js + src/ai/pool.js).
// Run: node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, benchLevels } from '../src/ai/worker.js';
import { TrainerPool, trainGeneration } from '../src/ai/pool.js';
import { TrainingSession, evaluateCandidates, benchmark, skillFromLevels } from '../src/ai/trainer.js';
import { packNotes } from '../src/core/map.js';
import { syntheticMap } from '../src/maps/patterns.js';

function smallSession(seed = 777) {
  return new TrainingSession({ seed, es: { popSize: 6 }, episodesPerGen: 2, episodeDur: 4, benchEvery: 3 });
}

test('worker handleMessage(eval) === evaluateCandidates', () => {
  const s = smallSession();
  const eps = s.curriculum.episodes(s.rng, 3, 4);
  const cands = s.es.ask().concat([s.es.theta]);
  const direct = evaluateCandidates(s.arch, cands, eps, s.hand);
  // pack like the pool does: one buffer, views per candidate
  const P = cands[0].length;
  const buf = new Float32Array(cands.length * P);
  const views = cands.map((c, k) => { const v = buf.subarray(k * P, (k + 1) * P); v.set(c); return v; });
  const out = handleMessage({ id: 42, arch: s.arch, candidates: views, episodes: eps, hand: s.hand });
  assert.equal(out.reply.id, 42);
  assert.ok(out.reply.fitness instanceof Float64Array);
  assert.deepEqual(Array.from(out.reply.fitness), direct.fitness);
  assert.deepEqual(Array.from(out.reply.acc), direct.acc);
  assert.equal(out.transfer.length, 2);
});

test('worker handles plain-array candidates, ping and custom maps', () => {
  const s = smallSession(5);
  assert.deepEqual(handleMessage({ type: 'ping', id: 3 }).reply, { type: 'pong', id: 3 });
  const packed = packNotes(syntheticMap(2, 99, 30));
  assert.equal(handleMessage({ type: 'map', key: 'user:test', packed }), null);
  const eps = [{ kind: 'custom', key: 'user:test', t0: 3, t1: 11 }];
  const cands = [Array.from(s.es.theta)];
  const direct = evaluateCandidates(s.arch, [s.es.theta], eps, s.hand);
  const out = handleMessage({ id: 1, arch: s.arch, candidates: cands, episodes: eps, hand: s.hand });
  assert.deepEqual(Array.from(out.reply.fitness), direct.fitness);
  assert.ok(direct.fitness[0] !== 0, 'custom map produced notes');
  handleMessage({ type: 'clearMaps' });
});

test('split benchmark (per level) === trainer.benchmark', () => {
  const s = smallSession(11);
  const ref = benchmark(s.arch, s.es.theta, s.hand);
  const a = benchLevels(s.arch, s.es.theta, s.hand, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  const b = benchLevels(s.arch, s.es.theta, s.hand, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  const merged = a.concat(b).sort((x, y) => x.level - y.level).map(({ level, acc }) => ({ level, acc }));
  assert.deepEqual(merged, ref.perLevel);
  assert.equal(skillFromLevels(merged), ref.skill);
  const viaMsg = handleMessage({ type: 'bench', id: 9, arch: s.arch, params: s.es.theta, hand: s.hand, levels: [3, 4] });
  assert.deepEqual(viaMsg.reply.perLevel.map((p) => p.acc), [ref.perLevel[3].acc, ref.perLevel[4].acc]);
});

test('TrainerPool main-thread fallback matches evaluateCandidates and benchmark', async () => {
  const pool = new TrainerPool({ forceMain: true, sliceMs: 2 });
  assert.equal(await pool.ready(), 'main');
  assert.equal(pool.size, 0);
  const s = smallSession(21);
  pool.arch = s.arch; pool.hand = s.hand;
  const eps = s.curriculum.episodes(s.rng, 3, 4);
  const cands = s.es.ask().concat([s.es.theta]);
  const direct = evaluateCandidates(s.arch, cands, eps, s.hand);
  const res = await pool.evaluate(cands, eps);
  assert.deepEqual(res, direct);
  const ref = benchmark(s.arch, s.es.theta, s.hand);
  assert.deepEqual(await pool.benchmark(s.arch, s.es.theta, s.hand), ref);
  pool.terminate();
});

test('TrainerPool without worker source falls back to main thread', async () => {
  const pool = new TrainerPool({ source: '' });
  assert.equal(await pool.ready(), 'main');
  assert.ok(pool.fallbackReason);
  pool.terminate();
});

test('trainGeneration (async benchmark) === TrainingSession.step', async () => {
  const a = smallSession(1234);
  const b = smallSession(1234);
  const evalSync = (arch, hand) => async (cands, eps) => evaluateCandidates(arch, cands, eps, hand);
  const pool = new TrainerPool({ forceMain: true, sliceMs: 50 });
  for (let g = 0; g < 7; g++) {
    const ra = await a.step(evalSync(a.arch, a.hand));
    const rb = await trainGeneration(b, evalSync(b.arch, b.hand), (arch, params, hand) => pool.benchmark(arch, params, hand), { benchEvery: 3 });
    const { accMean, fastForward, benchMs, ...core } = rb;
    assert.deepEqual(core, ra, `record of gen ${g + 1}`);
    assert.ok(accMean >= 0 && accMean <= 1);
    assert.equal(typeof fastForward, 'boolean');
  }
  assert.deepEqual(Array.from(b.es.theta), Array.from(a.es.theta));
  assert.deepEqual(Array.from(b.champion), Array.from(a.champion));
  assert.equal(b.skill, a.skill);
  assert.equal(b.bestSkill, a.bestSkill);
  assert.deepEqual(b.perLevel, a.perLevel);
  assert.equal(b.curriculum.level, a.curriculum.level);
  assert.equal(b.trainSeconds, a.trainSeconds);
  assert.equal(b.notesPlayed, a.notesPlayed);
  assert.equal(b.gen, 7);
  assert.equal(b.benchEvery, a.benchEvery);
  assert.deepEqual(b.history.map((r) => r.gen), [1, 2, 3, 4, 5, 6, 7]);
  pool.terminate();
});
