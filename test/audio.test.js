import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SONGS } from '../src/audio/songs.js';
import { composeSong, songEnergyAt, renderSong, LEAD_IN } from '../src/audio/synth.js';
import { noteTimesForDifficulty, DIFFICULTIES, minGapFor, chartStats } from '../src/audio/notetimes.js';

const KINDS = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'bass', 'lead', 'arp', 'chord', 'riser', 'impact']);
const DRUMS = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'riser', 'impact']);
const MIN_GAPS = { easy: 0.35, normal: 0.22, hard: 0.15, insane: 0.09, extreme: 0.065 };

const comps = new Map(SONGS.map((d) => [d.id, composeSong(d)]));

test('song list: 7–8 songs, unique ids, tempo range, lengths, beginner-friendly first song', () => {
  assert.ok(SONGS.length >= 7 && SONGS.length <= 8, `got ${SONGS.length} songs`);
  assert.equal(new Set(SONGS.map((s) => s.id)).size, SONGS.length);
  const bpms = SONGS.map((s) => s.bpm);
  assert.ok(Math.min(...bpms) <= 100 && Math.max(...bpms) >= 180, `bpm range ${Math.min(...bpms)}–${Math.max(...bpms)}`);
  for (const s of SONGS) {
    for (const k of ['id', 'title', 'artist', 'style', 'key', 'scale', 'color', 'mood']) assert.equal(typeof s[k], 'string', `${s.id}.${k}`);
    assert.ok(Number.isInteger(s.seed));
    assert.ok(s.lengthSec >= 75 && s.lengthSec <= 150, `${s.id} lengthSec`);
  }
  assert.ok(SONGS[0].bpm >= 100 && SONGS[0].bpm <= 125, 'first song should be medium tempo');
});

test('composeSong is deterministic (same seed → identical composition)', () => {
  for (const def of SONGS) {
    const a = composeSong(def);
    const b = composeSong({ ...def });
    assert.deepEqual(a.events, b.events, def.id);
    assert.deepEqual(a.sections, b.sections, def.id);
    assert.deepEqual(a.beatTimes, b.beatTimes, def.id);
  }
});

test('a different seed gives a different track', () => {
  const def = SONGS[0];
  const a = composeSong(def);
  const b = composeSong({ ...def, seed: def.seed + 1 });
  assert.notDeepEqual(
    a.events.filter((e) => e.kind === 'lead').map((e) => e.midi),
    b.events.filter((e) => e.kind === 'lead').map((e) => e.midi),
  );
});

test('events: sorted, valid, inside the song, first event after the lead-in', () => {
  for (const [id, c] of comps) {
    const ev = c.events;
    assert.ok(ev.length > 500, `${id}: only ${ev.length} events`);
    assert.ok(ev[0].t >= 1.5, `${id}: first event at ${ev[0].t}`);
    assert.ok(ev[0].t >= LEAD_IN - 1e-9);
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (i > 0) assert.ok(ev[i - 1].t <= e.t, `${id}: events not sorted at ${i}`);
      assert.ok(KINDS.has(e.kind), `${id}: bad kind ${e.kind}`);
      assert.ok(e.vel >= 0 && e.vel <= 1, `${id}: vel ${e.vel}`);
      assert.ok(e.dur > 0, `${id}: dur ${e.dur}`);
      assert.ok(e.t + e.dur <= c.duration + 1e-6, `${id}: ${e.kind} at ${e.t} ends after the song`);
      if (DRUMS.has(e.kind)) assert.equal(e.midi, null, `${id}: drum with pitch`);
      else assert.ok(Number.isInteger(e.midi) && e.midi >= 20 && e.midi <= 108, `${id}: midi ${e.midi}`);
    }
    for (const k of ['kick', 'bass', 'lead', 'chord', 'riser', 'impact']) {
      assert.ok(ev.some((e) => e.kind === k), `${id}: no ${k} events`);
    }
  }
});

test('timing grid and song structure', () => {
  for (const [id, c] of comps) {
    const def = c.def;
    assert.ok(Math.abs(c.duration - def.lengthSec) < 20, `${id}: duration ${c.duration} vs ${def.lengthSec}`);
    const spb = 60 / def.bpm;
    for (let i = 1; i < c.beatTimes.length; i++) assert.ok(Math.abs(c.beatTimes[i] - c.beatTimes[i - 1] - spb) < 1e-5);
    for (let i = 1; i < c.barTimes.length; i++) assert.ok(Math.abs(c.barTimes[i] - c.barTimes[i - 1] - 4 * spb) < 1e-5);
    const names = c.sections.map((s) => s.name);
    assert.equal(names[0], 'intro', id);
    assert.equal(names[names.length - 1], 'outro', id);
    assert.ok(names.filter((n) => n === 'drop').length >= 2, `${id}: needs two drops`);
    assert.ok(names.filter((n) => n === 'build').length >= 2, `${id}: needs two builds`);
    assert.ok(names.includes('break'), id);
    for (let i = 1; i < c.sections.length; i++) assert.ok(Math.abs(c.sections[i].start - c.sections[i - 1].end) < 1e-6, `${id}: gap between sections`);
    for (const s of c.sections) assert.ok(s.energy >= 0 && s.energy <= 1);
    // every build ends in a drop, and the drop starts with an impact
    c.sections.forEach((s, i) => {
      if (s.name !== 'build') return;
      assert.equal(c.sections[i + 1].name, 'drop', `${id}: build not followed by a drop`);
      const d = c.sections[i + 1];
      assert.ok(c.events.some((e) => e.kind === 'impact' && Math.abs(e.t - d.start) < 1e-6), `${id}: no impact on drop`);
      assert.ok(c.events.some((e) => e.kind === 'riser' && Math.abs(e.t - s.start) < 1e-6), `${id}: no riser in build`);
    });
  }
});

test('songEnergyAt: 0..1, drops are the most intense part', () => {
  for (const [id, c] of comps) {
    let maxDrop = 0, maxOther = 0;
    for (let t = 0; t < c.duration; t += 0.25) {
      const e = songEnergyAt(c, t);
      assert.ok(e >= 0 && e <= 1, `${id}: energy ${e} at ${t}`);
      const s = c.sections.find((x) => t >= x.start && t < x.end);
      if (s && s.name === 'drop') maxDrop = Math.max(maxDrop, e);
      else if (s && s.name !== 'build') maxOther = Math.max(maxOther, e);
    }
    assert.equal(maxDrop, 1, id);
    assert.ok(maxOther < 0.7, `${id}: non-drop energy too high (${maxOther})`);
    assert.ok(songEnergyAt(c, 0) < 0.2);
  }
});

test('DIFFICULTIES lists the five difficulties with names', () => {
  assert.deepEqual(DIFFICULTIES.map((d) => d.id), ['easy', 'normal', 'hard', 'insane', 'extreme']);
  for (const d of DIFFICULTIES) {
    assert.equal(typeof d.name, 'string');
    assert.equal(typeof d.ru, 'string');
    assert.equal(minGapFor(d.id), MIN_GAPS[d.id]);
  }
});

test('note times: sorted, min gaps respected, on real sounds, denser with difficulty', () => {
  const rows = [];
  for (const [id, c] of comps) {
    const onsets = new Set(c.events.map((e) => e.t));
    const wobbles = c.events.filter((e) => e.kind === 'bass' && e.wob >= 2);
    const counts = [];
    const row = { song: id, bpm: c.bpm, sec: +c.duration.toFixed(0) };
    for (const d of DIFFICULTIES) {
      const notes = noteTimesForDifficulty(c, d.id);
      assert.ok(notes.length > 30, `${id}/${d.id}: only ${notes.length} notes`);
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        assert.ok(n.strength >= 0 && n.strength <= 1);
        assert.equal(typeof n.stream, 'boolean');
        assert.ok(KINDS.has(n.kind));
        assert.ok(n.midi === null || Number.isInteger(n.midi));
        assert.ok(n.t >= 1.5 && n.t < c.duration);
        // every note sits on an event onset, or on a wobble pulse of a playing wobble-bass note
        assert.ok(onsets.has(n.t) || wobbles.some((w) => n.t > w.t && n.t < w.t + w.dur), `${id}/${d.id}: note at ${n.t} has no sound`);
        if (i > 0) {
          const gap = n.t - notes[i - 1].t;
          assert.ok(gap >= MIN_GAPS[d.id] - 1e-9, `${id}/${d.id}: gap ${gap.toFixed(4)} < ${MIN_GAPS[d.id]} at ${n.t}`);
        }
      }
      counts.push(notes.length);
      const st = chartStats(notes, c);
      row[d.id] = `${notes.length} (${st.nps.toFixed(1)}/s, pk ${st.peakNps})`;
    }
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] > counts[i - 1], `${id}: ${DIFFICULTIES[i].id} (${counts[i]}) not denser than ${DIFFICULTIES[i - 1].id} (${counts[i - 1]})`);
    }
    rows.push(row);
  }
  console.log('\nNote counts per song / difficulty (notes, average NPS, peak notes in 1 s):');
  console.table(rows);
});

test('note times: drops are denser than intros and breaks', () => {
  for (const [id, c] of comps) {
    for (const d of ['normal', 'hard', 'insane']) {
      const notes = noteTimesForDifficulty(c, d);
      const density = (name) => {
        let n = 0, len = 0;
        for (const s of c.sections.filter((x) => x.name === name)) {
          len += s.end - s.start;
          n += notes.filter((x) => x.t >= s.start && x.t < s.end).length;
        }
        return n / Math.max(1e-9, len);
      };
      assert.ok(density('drop') > density('intro'), `${id}/${d}: drop not denser than intro`);
      assert.ok(density('drop') > density('break'), `${id}/${d}: drop not denser than break`);
    }
  }
});

test('renderSong explains that it needs Web Audio when run outside a browser', async () => {
  if (globalThis.OfflineAudioContext) return; // real Web Audio available: nothing to check here
  await assert.rejects(() => renderSong(comps.get(SONGS[0].id)), /Web Audio/);
});
