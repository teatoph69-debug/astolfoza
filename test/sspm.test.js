import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSSPM, isSSPM } from '../src/maps/sspm.js';

const fx = (f) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f);
const read = (f) => new Uint8Array(fs.readFileSync(fx(f)));

// reference notes: [x, y, ms] in .sspm orientation (= ours), sorted like SS+ notesort (t, y, x)
const REF = JSON.parse(fs.readFileSync(fx('sspm_notes.json'), 'utf8'))
  .map(([x, y, t]) => ({ t: t / 1000, x, y }))
  .sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x);

function assertNotes(notes, ref = REF) {
  assert.equal(notes.length, ref.length);
  for (let i = 0; i < ref.length; i++) {
    assert.ok(Math.abs(notes[i].t - ref[i].t) < 1e-9, `t @${i}`);
    assert.ok(Math.abs(notes[i].x - ref[i].x) < 1e-5, `x @${i}: ${notes[i].x} vs ${ref[i].x}`);
    assert.ok(Math.abs(notes[i].y - ref[i].y) < 1e-5, `y @${i}: ${notes[i].y} vs ${ref[i].y}`);
  }
}

test('fixtures: real notes (135, 115 quantum)', () => {
  assert.equal(REF.length, 135);
  assert.equal(REF.filter((n) => n.x !== Math.round(n.x) || n.y !== Math.round(n.y)).length, 115);
});

test('v1 file (SS+ convert_to_sspm_v1 layout)', () => {
  const m = parseSSPM(read('sspm_v1.sspm').buffer);
  assert.equal(m.version, 1);
  assert.equal(m.id, 'test_id');
  assert.equal(m.name, 'Artist - Title');
  assert.equal(m.artist, 'Artist');
  assert.equal(m.title, 'Title');
  assert.deepEqual(m.mappers, ['MapperA', 'MapperB']);
  assert.equal(m.difficulty, 3);
  assert.equal(m.difficultyName, 'Hard');
  assert.equal(m.audioMime, 'audio/mpeg');
  assert.ok(m.audio instanceof ArrayBuffer && m.audio.byteLength === 32);
  assert.equal(m.coverMime, 'image/png');
  assertNotes(m.notes);
  assert.deepEqual(m.warnings, []);
});

test('v2 file (SS+ convert_to_sspm: custom data with an array, extra marker type)', () => {
  const m = parseSSPM(read('sspm_v2_ssp.sspm'));
  assert.equal(m.version, 2);
  assert.equal(m.songName, 'Title');
  assert.equal(m.artist, 'Artist'); // song name has no artist → taken from the map name
  assert.equal(m.title, 'Title');
  assert.equal(m.difficulty, 5);
  assert.equal(m.difficultyName, 'Insane-ish'); // custom difficulty_name wins
  assert.deepEqual(m.customData.some_array, [7, 8, 9]);
  assertNotes(m.notes); // the two "test_speed" markers are skipped
  assert.equal(new Uint8Array(m.audio)[0], 0x49);
  assert.equal(m.coverMime, 'image/png');
});

test('v2 file written by pysspm-rhythia', () => {
  const m = parseSSPM(read('sspm_v2_pysspm.sspm'));
  assert.equal(m.version, 2);
  assert.equal(m.id, 'whip_Artist_-_Title');
  assert.deepEqual(m.mappers, ['whip']);
  assert.equal(m.difficultyName, 'Hard');
  assertNotes(m.notes);
});

test('output is in our grid space / seconds and sorted by (t, y, x)', () => {
  const m = parseSSPM(read('sspm_v2_ssp.sspm'));
  for (let i = 1; i < m.notes.length; i++) {
    const a = m.notes[i - 1], b = m.notes[i];
    assert.ok(a.t < b.t || (a.t === b.t && (a.y < b.y || (a.y === b.y && a.x <= b.x))));
  }
  assert.ok(m.notes[m.notes.length - 1].t < 10); // seconds, not ms
});

// ---- hand-built edge cases --------------------------------------------------------------------

const enc = new TextEncoder();
class W {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { return this.u8(v).u8(v >> 8); }
  u32(v) { return this.u16(v & 0xffff).u16(v >>> 16); }
  u64(v) { return this.u32(v % 2 ** 32).u32(Math.floor(v / 2 ** 32)); }
  f32(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(d.getUint8(i)); return this; }
  bytes(a) { for (const x of a) this.u8(x); return this; }
  str16(s) { const e = enc.encode(s); return this.u16(e.length).bytes(e); }
  line(s) { return this.bytes(enc.encode(s + '\n')); }
  pos(x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 ? this.u8(0).u8(x).u8(y) : this.u8(1).f32(x).f32(y); }
  get length() { return this.b.length; }
  out() { return new Uint8Array(this.b); }
}

/** Minimal v2 writer. markerDefs: [[name, [types]]]; markers: [[ms, typeIndex, writerFn]] */
function writeV2({ notes = [], customOffsetZero = false, difficulty = 3, defs = [['ssp_note', [7]]], extraMarkers = [], audio = null, cover = null, customName = null }) {
  const noteDef = defs.findIndex((d) => d[0] === 'ssp_note');
  const markers = [...notes.map((n) => [n[2], noteDef, (w) => w.pos(n[0], n[1])]), ...extraMarkers].sort((a, b) => a[0] - b[0]);
  const strings = new W().str16('edge_id').str16('Some Artist - Some Song').str16('Some Artist - Some Song').u16(1).str16('Mapper');
  const custom = new W();
  if (customName) custom.u16(1).str16('difficulty_name').u8(0x09).str16(customName);
  else custom.u16(0);
  const md = new W().u8(defs.length);
  for (const [name, types] of defs) { md.str16(name).u8(types.length).bytes(types).u8(0); }
  const mk = new W();
  for (const [ms, ti, fn] of markers) { mk.u32(ms).u8(ti); fn(mk); }
  const base = 0x80 + strings.length;
  const cdOff = base, aOff = cdOff + custom.length, cOff = aOff + (audio ? audio.length : 0);
  const mdOff = cOff + (cover ? cover.length : 0), mkOff = mdOff + md.length;
  const w = new W().bytes([0x53, 0x53, 0x2b, 0x6d]).u16(2).u32(0).bytes(new Uint8Array(20));
  w.u32(markers.length ? markers[markers.length - 1][0] : 0).u32(notes.length).u32(markers.length);
  w.u8(difficulty).u16(0).u8(audio ? 1 : 0).u8(cover ? 1 : 0).u8(0);
  w.u64(customOffsetZero ? 0 : cdOff).u64(customOffsetZero ? 0 : custom.length);
  w.u64(audio ? aOff : 0).u64(audio ? audio.length : 0);
  w.u64(cover ? cOff : 0).u64(cover ? cover.length : 0);
  w.u64(mdOff).u64(md.length).u64(mkOff).u64(mk.length);
  assert.equal(w.length, 0x80);
  w.bytes(strings.out()).bytes(custom.out());
  if (audio) w.bytes(audio);
  if (cover) w.bytes(cover);
  w.bytes(md.out()).bytes(mk.out());
  return w.out();
}

const NOTES = [[1, 1, 500], [0, 0, 250], [2.25, -0.5, 750], [1, 2, 250]];

test('SSQE style: custom data pointer 0 (stray bytes must not be read as a field count)', () => {
  const m = parseSSPM(writeV2({ notes: NOTES, customOffsetZero: true, difficulty: 4 }));
  assert.equal(m.difficultyName, 'Logic');
  assert.equal(m.artist, 'Some Artist');
  assert.equal(m.title, 'Some Song');
  assert.deepEqual(m.notes.map((n) => [n.t, n.x, n.y]), [[0.25, 0, 0], [0.25, 1, 2], [0.5, 1, 1], [0.75, 2.25, -0.5]]);
});

test('note definition that is not first + non-note markers of other types are skipped', () => {
  const buf = writeV2({
    notes: NOTES,
    defs: [['bpm_change', [0x05, 0x09]], ['ssp_note', [7]]],
    extraMarkers: [[0, 0, (w) => w.f32(180).str16('x')], [600, 0, (w) => w.f32(200).str16('yz')]],
    customName: 'Хардкор',
  });
  const m = parseSSPM(buf);
  assert.equal(m.notes.length, 4);
  assert.equal(m.difficultyName, 'Хардкор');
  assert.deepEqual(m.warnings, []);
});

test('audio / cover blocks are sniffed and returned as standalone ArrayBuffers', () => {
  const ogg = enc.encode('OggS....vorbis');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]);
  const m = parseSSPM(writeV2({ notes: NOTES, audio: ogg, cover: png }));
  assert.equal(m.audioMime, 'audio/ogg');
  assert.equal(m.audio.byteLength, ogg.length);
  assert.equal(m.coverMime, 'image/png');
});

test('truncated inside the marker block → partial notes + warning; inside the header → clear error', () => {
  const full = writeV2({ notes: NOTES });
  const m = parseSSPM(full.slice(0, full.length - 5));
  assert.ok(m.notes.length >= 2 && m.notes.length < 4);
  assert.ok(m.warnings.length > 0);
  assert.throws(() => parseSSPM(full.slice(0, 60)), (e) => e.code === 'MAP_FORMAT' && /обрезан|повреждён/.test(e.message) && !!e.en);
});

test('garbage / wrong versions are rejected with a Russian message', () => {
  assert.throws(() => parseSSPM(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /не файл \.sspm/);
  assert.throws(() => parseSSPM(new ArrayBuffer(0)), /не файл \.sspm/);
  const v3 = writeV2({ notes: NOTES });
  v3[4] = 3;
  assert.throws(() => parseSSPM(v3), /версия/);
  const noNotes = writeV2({ notes: [] });
  assert.throws(() => parseSSPM(noNotes), /нет ни одной ноты/);
  assert.equal(isSSPM(enc.encode('SS+m')), true);
  assert.equal(isSSPM(enc.encode('PK..')), false);
});

test('random corruption never throws anything but a MAP_FORMAT error', () => {
  const base = writeV2({ notes: NOTES, customName: 'X' });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 400; k++) {
    const b = base.slice();
    const n = 1 + Math.floor(rnd() * 6);
    for (let j = 0; j < n; j++) b[4 + Math.floor(rnd() * (b.length - 4))] = Math.floor(rnd() * 256);
    try { parseSSPM(b); } catch (e) { assert.equal(e.code, 'MAP_FORMAT', e.stack); }
  }
});

test('v1: CRLF lines, unsorted notes, quantum negatives, audio without cover', () => {
  const w = new W().bytes([0x53, 0x53, 0x2b, 0x6d]).u16(1).u16(0);
  w.line('crlf_id\r').line('Artist - Title\r').line('A, B & C\r');
  w.u32(900).u32(3).u8(1).u8(0); // difficulty Easy, no cover
  const audio = enc.encode('ID3\x03fake');
  w.u8(1).u64(audio.length).bytes(audio);
  w.u32(900).pos(2, 2).u32(100).pos(-0.5, 1.5).u32(100).pos(0, 0);
  const m = parseSSPM(w.out());
  assert.equal(m.id, 'crlf_id');
  assert.deepEqual(m.mappers, ['A', 'B', 'C']);
  assert.equal(m.difficultyName, 'Easy');
  assert.equal(m.audioMime, 'audio/mpeg');
  assert.equal(m.cover, null);
  assert.deepEqual(m.notes.map((n) => [n.t, n.x, n.y]), [[0.1, 0, 0], [0.1, -0.5, 1.5], [0.9, 2, 2]]);
});
