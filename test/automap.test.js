import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMap, analyzeRhythm, makeRealFFT, AUTO_DIFFICULTIES } from '../src/maps/automap.js';
import { mulberry32 } from '../src/core/rng.js';

// ---- synthetic test signals (pure JS) ---------------------------------------------------------

function clickTrack({ bpm, dur = 30, sr = 44100, start = 0.5, seed = 1 }) {
  const n = Math.floor(dur * sr), x = new Float32Array(n), rnd = mulberry32(seed);
  const period = 60 / bpm, times = [];
  for (let k = 0; start + k * period < dur - 0.1; k++) {
    const t = start + k * period;
    times.push(t);
    const i0 = Math.round(t * sr), amp = k % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < 0.03 * sr && i0 + i < n; i++) {
      const tt = i / sr;
      x[i0 + i] += amp * (0.8 * Math.exp(-tt * 180) * Math.sin(2 * Math.PI * 1800 * tt) + 0.4 * (rnd() * 2 - 1) * Math.exp(-tt * 400));
    }
  }
  return { sampleRate: sr, channelData: [x], times };
}

/** Kick on 1 & 3 (+ the "and" of 4), snare on 2 & 4, 16th-note hats, a sustained chord pad. */
function drumLoop({ bpm, dur = 40, sr = 44100, start = 0.3, seed = 7, stereo = false }) {
  const n = Math.floor(dur * sr), x = new Float32Array(n), rnd = mulberry32(seed);
  const beat = 60 / bpm, kicks = [], snares = [], hats = [];
  for (let b = 0; start + b * beat < dur - 0.3; b++) {
    const t = start + b * beat;
    (b % 2 === 0 ? kicks : snares).push(t);
    if (b % 4 === 3) kicks.push(t + beat / 2);
    for (let s = 0; s < 4; s++) hats.push(t + (s * beat) / 4);
  }
  const add = (t, fn, len) => { const i0 = Math.round(t * sr); for (let i = 0; i < len * sr && i0 + i < n; i++) x[i0 + i] += fn(i / sr); };
  for (const t of kicks) add(t, (tt) => Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 9) * 0.9, 0.35);
  for (const t of snares) add(t, (tt) => (rnd() * 2 - 1) * 0.5 * Math.exp(-tt * 22) + 0.35 * Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt * 30), 0.25);
  hats.forEach((t, i) => add(t, (tt) => (rnd() * 2 - 1) * (i % 4 === 0 ? 0.2 : 0.1) * Math.exp(-tt * 70), 0.06));
  const chords = [[220, 277, 330], [196, 247, 294], [175, 220, 262], [196, 247, 294]];
  for (let i = Math.round(start * sr); i < n; i++) {
    const t = i / sr, c = chords[Math.floor((t - start) / (beat * 4)) % 4];
    x[i] += 0.04 * (Math.sin(2 * Math.PI * c[0] * t) + Math.sin(2 * Math.PI * c[1] * t) + Math.sin(2 * Math.PI * c[2] * t));
  }
  const events = [...kicks, ...snares, ...hats].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.005);
  const channelData = stereo ? [x, Float32Array.from(x, (v) => v * 0.8)] : [x];
  return { sampleRate: sr, channelData, kicks, snares, hats, events };
}

const nearest = (arr, t) => arr.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best), Infinity);

// ---- tests ------------------------------------------------------------------------------------

test('real FFT (power spectrum) matches a naive DFT', () => {
  for (const N of [16, 64, 1024]) {
    const rnd = mulberry32(N);
    const x = Float32Array.from({ length: N }, () => rnd() * 2 - 1);
    const out = new Float64Array(N / 2 + 1);
    makeRealFFT(N)(x, out);
    for (let k = 0; k <= N / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) { re += x[n] * Math.cos((2 * Math.PI * k * n) / N); im -= x[n] * Math.sin((2 * Math.PI * k * n) / N); }
      const p = re * re + im * im;
      assert.ok(Math.abs(out[k] - p) <= 1e-6 * (1 + p), `N=${N} k=${k}: ${out[k]} vs ${p}`);
    }
  }
});

for (const bpm of [128, 174]) {
  test(`click track at ${bpm} BPM: tempo within ±2 BPM, every click found within ±20 ms, no strong false onsets`, async () => {
    const sig = clickTrack({ bpm, start: 0.37 });
    const r = await analyzeRhythm(sig);
    assert.ok(Math.abs(r.bpm - bpm) <= 2, `bpm ${r.bpm}`);
    assert.equal(r.grid, 'global');
    assert.ok(r.confidence > 0.7, `confidence ${r.confidence}`);
    const strong = r.onsets.filter((o) => o.strength >= 0.25).map((o) => o.t);
    for (const t of sig.times) assert.ok(Math.abs(nearest(strong, t) - t) <= 0.02, `click at ${t.toFixed(3)} missed`);
    for (const t of strong) assert.ok(Math.abs(nearest(sig.times, t) - t) <= 0.02, `false onset at ${t.toFixed(3)}`);
    // beat phase: the grid offset lines up with the clicks
    const period = 60 / bpm;
    const phaseErr = Math.abs(((r.offset - (0.37 % period)) % period + period * 1.5) % period - period / 2);
    assert.ok(phaseErr < 0.015, `offset ${r.offset}`);
  });
}

test('drum loop (kick / snare / 16th hats / pad) at 124 BPM: tempo and drum onsets', async () => {
  const sig = drumLoop({ bpm: 124 });
  const r = await analyzeRhythm(sig);
  assert.ok(Math.abs(r.bpm - 124) <= 2, `bpm ${r.bpm}`);
  const on = r.onsets.map((o) => o.t);
  for (const t of [...sig.kicks, ...sig.snares]) assert.ok(Math.abs(nearest(on, t) - t) <= 0.02, `drum hit at ${t.toFixed(3)} missed`);
  let within = 0;
  for (const t of on) if (Math.abs(nearest(sig.events, t) - t) <= 0.02) within++;
  assert.ok(within / on.length > 0.95, `only ${within}/${on.length} onsets on real events`);
});

test('autoMap: five difficulties, denser as they get harder, min gaps respected, notes on the music', async () => {
  const sig = drumLoop({ bpm: 120, dur: 45, stereo: true });
  const res = await autoMap(sig, { seed: 5 });
  assert.ok(Math.abs(res.bpm - 120) <= 2);
  assert.deepEqual(res.maps.map((m) => m.difficultyId), ['easy', 'normal', 'hard', 'insane', 'extreme']);
  const minGaps = { easy: 0.35, normal: 0.22, hard: 0.15, insane: 0.09, extreme: 0.065 };
  let prev = 0;
  for (const m of res.maps) {
    assert.ok(m.notes.length >= prev, `${m.difficultyId} (${m.notes.length}) sparser than the previous (${prev})`);
    prev = m.notes.length;
    for (let i = 0; i < m.notes.length; i++) {
      const n = m.notes[i];
      assert.ok(n.t >= 0 && n.t <= 45, 'inside the song');
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && n.x >= 0 && n.x <= 2 && n.y >= 0 && n.y <= 2);
      assert.ok(Math.abs(nearest(sig.events, n.t) - n.t) <= 0.025, `${m.difficultyId}: note at ${n.t} is not on a drum hit`);
      if (i) assert.ok(n.t - m.notes[i - 1].t >= minGaps[m.difficultyId] - 1e-6, `${m.difficultyId}: gap ${n.t - m.notes[i - 1].t}`);
    }
    assert.ok(typeof m.stars === 'number' && m.stars >= 0);
  }
  const [easy, , hard, , extreme] = res.maps;
  assert.ok(extreme.notes.length > easy.notes.length * 2, `extreme ${extreme.notes.length} vs easy ${easy.notes.length}`);
  assert.ok(easy.stars < hard.stars && hard.stars < extreme.stars, res.maps.map((m) => m.stars).join(' < '));
  assert.ok(Math.abs(easy.stars - AUTO_DIFFICULTIES[0].stars) < 1.5, `easy stars ${easy.stars}`);
});

test('AudioBuffer-like input (getChannelData) at 48 kHz works the same', async () => {
  const sig = clickTrack({ bpm: 140, sr: 48000, dur: 20 });
  const ab = { sampleRate: 48000, numberOfChannels: 1, length: sig.channelData[0].length, getChannelData: () => sig.channelData[0] };
  const r = await analyzeRhythm(ab);
  assert.ok(Math.abs(r.bpm - 140) <= 2);
});

test('silence / noise-free empty audio is rejected with a clear error', async () => {
  const silent = { sampleRate: 44100, channelData: [new Float32Array(44100 * 5)] };
  await assert.rejects(autoMap(silent), (e) => e.code === 'MAP_FORMAT' && /ритма/.test(e.message));
  await assert.rejects(autoMap({ sampleRate: 44100, channelData: [] }), (e) => e.code === 'MAP_FORMAT');
});

test('fast enough: 3 minutes of audio analysed + mapped in well under 3 s (Node)', async () => {
  const sig = drumLoop({ bpm: 150, dur: 180 });
  const t0 = performance.now();
  const res = await autoMap(sig, { seed: 1 });
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  assert.ok(res.maps.every((m) => m.notes.length > 50));
});
