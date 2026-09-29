// Map library: built-in procedural songs (always available, offline) + maps imported by the user
// (.sspm from Rhythia, legacy .txt maps, auto-mapped audio files), persisted in IndexedDB.
//
// Mapset shape:
// { id, title, artist, mapper, source: 'builtin'|'sspm'|'txt'|'auto', color, cover?, bpm?,
//   maps: [map], audio: { kind:'song', songId } | { kind:'bytes', bytes, mime } | { kind:'none' } }
// Map shape: see core/map.js (each map also gets .setId and .id)

import { SONGS } from '../audio/songs.js';
import { composeSong, renderSong } from '../audio/synth.js';
import { noteTimesForDifficulty, DIFFICULTIES } from '../audio/notetimes.js';
import { placeNotes } from './patterns.js';
import { computeStars } from '../core/map.js';
import { hashString } from '../core/rng.js';
import { idb } from '../ui/store.js';
import { Emitter } from '../ui/dom.js';

// Target "stars" per built-in difficulty, used by the pattern generator for spacing / shapes.
const DIFF_STARS = { easy: 1.2, normal: 2.8, hard: 4.8, insane: 6.8, extreme: 9 };

export class MapLibrary extends Emitter {
  constructor(audioEngine) {
    super();
    this.audio = audioEngine;
    this.sets = [];
    this.byMapId = new Map();
    this._compositions = new Map();
    this._buffers = new Map();     // setId -> AudioBuffer
    this._pending = new Map();     // setId -> Promise<AudioBuffer>
  }

  async init() {
    this.sets = [];
    for (const def of SONGS) this._addSet(this.builtinSet(def));
    const stored = await idb.all('maps');
    for (const set of stored || []) {
      if (set && set.id && Array.isArray(set.maps)) this._addSet(set);
    }
    this.emit('change');
  }

  composition(songId) {
    let c = this._compositions.get(songId);
    if (!c) {
      const def = SONGS.find((s) => s.id === songId);
      c = composeSong(def);
      this._compositions.set(songId, c);
    }
    return c;
  }

  builtinSet(def) {
    const comp = this.composition(def.id);
    const maps = DIFFICULTIES.map((d) => {
      const times = noteTimesForDifficulty(comp, d.id);
      const notes = placeNotes(times, { stars: DIFF_STARS[d.id] ?? 4, seed: hashString(def.id + ':' + d.id) });
      return {
        id: `builtin:${def.id}:${d.id}`,
        title: def.title,
        artist: def.artist,
        mapper: 'МУХА auto-mapper',
        difficultyName: d.name,
        difficultyId: d.id,
        notes,
        stars: computeStars(notes),
        duration: comp.duration,
        source: 'builtin',
      };
    });
    return {
      id: `builtin:${def.id}`,
      title: def.title,
      artist: def.artist,
      mapper: 'МУХА auto-mapper',
      source: 'builtin',
      color: def.color,
      bpm: def.bpm,
      style: def.style,
      mood: def.mood,
      audio: { kind: 'song', songId: def.id },
      maps,
    };
  }

  _addSet(set) {
    const idx = this.sets.findIndex((s) => s.id === set.id);
    if (idx >= 0) this.sets[idx] = set; else this.sets.push(set);
    for (const m of set.maps) {
      m.setId = set.id;
      if (!m.id) m.id = `${set.id}:${m.difficultyName || 'map'}`;
      if (m.stars == null) m.stars = computeStars(m.notes);
      this.byMapId.set(m.id, m);
    }
  }

  getSet(id) { return this.sets.find((s) => s.id === id) || null; }
  getMap(id) { return this.byMapId.get(id) || null; }
  allMaps() { return this.sets.flatMap((s) => s.maps); }

  /** Add (and persist) an imported mapset. */
  async addSet(set) {
    this._addSet(set);
    if (set.source !== 'builtin') {
      // store without derived fields that are cheap to recompute
      await idb.set('maps', set.id, set);
    }
    this.emit('change');
    return set;
  }

  async removeSet(id) {
    const set = this.getSet(id);
    if (!set || set.source === 'builtin') return;
    this.sets = this.sets.filter((s) => s.id !== id);
    for (const m of set.maps) this.byMapId.delete(m.id);
    this._buffers.delete(id);
    await idb.del('maps', id);
    this.emit('change');
  }

  /** Seed the audio cache (e.g. the importer already decoded the file for auto-mapping). */
  primeAudioBuffer(setId, audioBuffer) {
    if (audioBuffer) this._buffers.set(setId, audioBuffer);
  }

  /** AudioBuffer for a map's set (renders procedural music on first use). null if the map has no audio. */
  async getAudioBuffer(mapOrSet, onProgress) {
    const set = mapOrSet.maps ? mapOrSet : this.getSet(mapOrSet.setId);
    if (!set) return null;
    if (this._buffers.has(set.id)) return this._buffers.get(set.id);
    if (this._pending.has(set.id)) return this._pending.get(set.id);
    const p = (async () => {
      let buf = null;
      const a = set.audio || { kind: 'none' };
      if (a.kind === 'song') {
        onProgress && onProgress(0.1);
        buf = await renderSong(this.composition(a.songId));
      } else if (a.kind === 'bytes' && a.bytes) {
        buf = await this.audio.decode(a.bytes);
      }
      this._buffers.set(set.id, buf);
      this._pending.delete(set.id);
      onProgress && onProgress(1);
      return buf;
    })().catch((e) => {
      console.error('audio load failed', e);
      this._pending.delete(set.id);
      return null;
    });
    this._pending.set(set.id, p);
    return p;
  }
}
