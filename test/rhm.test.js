import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseRHM, parsePHXM, readZip, isZip, looksLikeRHM, looksLikePHXM } from '../src/maps/rhm.js';

// ---- a tiny ZIP writer (stored + deflate, optional data descriptors) --------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) { let c = 0xffffffff; for (const b of u8) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** entries: [{ name, data: Uint8Array|string, method?: 0|8, descriptor?: boolean }] */
export function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const le = (n, v) => { const b = Buffer.alloc(n); if (n === 2) b.writeUInt16LE(v); else b.writeUInt32LE(v >>> 0); return b; };
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const name = Buffer.from(e.name, 'utf8');
    const flags = 0x800 | (e.descriptor ? 8 : 0);
    const local = Buffer.concat([le(4, 0x04034b50), le(2, 20), le(2, flags), le(2, method), le(2, 0), le(2, 0),
      le(4, e.descriptor ? 0 : crc), le(4, e.descriptor ? 0 : comp.length), le(4, e.descriptor ? 0 : data.length),
      le(2, name.length), le(2, 0), name]);
    chunks.push(local, comp);
    if (e.descriptor) chunks.push(Buffer.concat([le(4, 0x08074b50), le(4, crc), le(4, comp.length), le(4, data.length)]));
    central.push(Buffer.concat([le(4, 0x02014b50), le(2, 20), le(2, 20), le(2, flags), le(2, method), le(2, 0), le(2, 0),
      le(4, crc), le(4, comp.length), le(4, data.length), le(2, name.length), le(2, 0), le(2, 0), le(2, 0), le(2, 0),
      le(4, 0), le(4, offset), name]));
    offset += local.length + comp.length + (e.descriptor ? 16 : 0);
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, entries.length), le(2, entries.length),
    le(4, cd.length), le(4, offset), le(2, 0)]);
  return new Uint8Array(Buffer.concat([...chunks, cd, eocd]));
}

const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);

const MAP = {
  OnlineId: null, OnlineStatus: null, LegacyId: '5860246058480dfb', SongName: 'nature - chirp', Mappers: ['whip'],
  Title: 'nature - chirp', Duration: 465, Difficulty: 3, CustomDifficultyName: null, StarRating: 4.25,
  Notes: [{ Time: 400, X: 2.1525886, Y: -0.5715259 }, { Time: 0, X: 0, Y: 2 }, { Time: 0, X: -0, Y: 0 }, { Time: 111, X: 1, Y: 1 }],
  AudioFileName: 'birds.mp3', ImagePath: 'cover', TimingPoints: [],
};

test('zip reader: stored + deflate entries, sniffing', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello hello hello hello', method: 8 }, { name: 'b.bin', data: FAKE_MP3, method: 0 }]);
  assert.ok(isZip(zip));
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'b.bin']);
  assert.equal(new TextDecoder().decode(await entries[0].read()), 'hello hello hello hello');
  assert.deepEqual([...(await entries[1].read())], [...FAKE_MP3]);
  // injectable inflater (e.g. zlib in Node, a JS inflate elsewhere)
  const e2 = readZip(zip, { inflateRaw: (u8) => zlib.inflateRawSync(u8) });
  assert.equal(new TextDecoder().decode(await e2[0].read()), 'hello hello hello hello');
});

test('.rhm: metadata, notes (ms → s, sorted, -0 → 0), audio + cover', async () => {
  const rhm = makeZip([
    { name: 'map', data: JSON.stringify(MAP) },
    { name: 'audio', data: FAKE_MP3, method: 0 },
    { name: 'cover', data: FAKE_PNG },
  ]);
  assert.ok(looksLikeRHM(readZip(rhm)));
  for (const opts of [{}, { inflateRaw: (u8) => zlib.inflateRawSync(u8) }]) {
    const m = await parseRHM(rhm.buffer, opts);
    assert.equal(m.version, 'rhm');
    assert.equal(m.id, '5860246058480dfb');
    assert.equal(m.artist, 'nature');
    assert.equal(m.title, 'chirp');
    assert.deepEqual(m.mappers, ['whip']);
    assert.equal(m.difficulty, 3);
    assert.equal(m.difficultyName, 'Hard');
    assert.equal(m.rating, 4.25);
    assert.deepEqual(m.notes, [
      { t: 0, x: 0, y: 0 }, { t: 0, x: 0, y: 2 }, { t: 0.111, x: 1, y: 1 }, { t: 0.4, x: 2.152589, y: -0.571526 },
    ]);
    assert.ok(Object.is(m.notes[0].x, 0)); // not -0
    assert.equal(m.audioMime, 'audio/mpeg');
    assert.equal(m.audio.byteLength, FAKE_MP3.length);
    assert.equal(m.coverMime, 'image/png');
  }
});

test('.rhm: defensive JSON (other casing, custom name, audio found via AudioFileName, no cover, data descriptors)', async () => {
  const json = {
    songname: 'Artist - Song', title: 'Artist - Song [Insane]', mappers: 'A & B', difficulty: 0,
    customDifficultyName: '  Insane  ', notes: [{ time: 1000, x: '1', y: 0.5 }, { TIME: 'bad', X: 1, Y: 1 }, [2, 2, 1500]],
    AudioFileName: 'song.ogg', ImagePath: null,
  };
  const rhm = makeZip([
    { name: 'map', data: '﻿' + JSON.stringify(json), descriptor: true },
    { name: 'song.ogg', data: new TextEncoder().encode('OggS-fake'), descriptor: true },
  ]);
  const m = await parseRHM(rhm);
  assert.equal(m.artist, 'Artist');
  assert.equal(m.title, 'Song');
  assert.deepEqual(m.mappers, ['A', 'B']);
  assert.equal(m.difficultyName, 'Insane');
  assert.deepEqual(m.notes, [{ t: 1, x: 1, y: 0.5 }, { t: 1.5, x: 2, y: 2 }]);
  assert.equal(m.audioMime, 'audio/ogg');
  assert.equal(m.cover, null);
});

test('.rhm: truncated archive falls back to local headers; broken inputs give clear errors', async () => {
  const rhm = makeZip([{ name: 'map', data: JSON.stringify(MAP) }, { name: 'audio', data: FAKE_MP3, method: 0 }]);
  // cut off the central directory: entries are still reachable through their local headers
  const cut = rhm.slice(0, rhm.length - 60);
  const m = await parseRHM(cut);
  assert.equal(m.notes.length, 4);

  await assert.rejects(parseRHM(new Uint8Array([1, 2, 3, 4])), (e) => e.code === 'MAP_FORMAT');
  await assert.rejects(parseRHM(makeZip([{ name: 'readme.txt', data: 'hi' }])), /нет файла «map»/);
  await assert.rejects(parseRHM(makeZip([{ name: 'map', data: '{not json' }])), /неверный JSON/);
  await assert.rejects(parseRHM(makeZip([{ name: 'map', data: JSON.stringify({ Notes: [] }) }])), /нет ни одной ноты/);
  const corrupt = makeZip([{ name: 'map', data: JSON.stringify(MAP) }]);
  corrupt[40] ^= 0xff; corrupt[45] ^= 0xff; // damage the deflate stream
  await assert.rejects(parseRHM(corrupt), (e) => e.code === 'MAP_FORMAT');
});

test('.phxm: metadata.json + objects.phxmo (centred, +y up) → our grid', async () => {
  const meta = { ID: 'phx_id', Artist: 'Art', Title: 'Tune', Mappers: ['m1'], Difficulty: 4, DifficultyName: '',
    Length: 2000, HasAudio: true, HasCover: false, HasVideo: false, AudioExt: 'mp3' };
  const objs = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); objs.push(b); };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); objs.push(b); };
  u32(12); u32(3);
  u32(500); objs.push(Buffer.from([0, 0, 2])); // on-grid: stored x+1 = 0 (left), y+1 = 2 (top)
  u32(250); objs.push(Buffer.from([1])); f32(0.5); f32(-1); // quantum centred (0.5, −1) → (1.5, 2)
  u32(750); objs.push(Buffer.from([0, 1, 1])); // centre
  for (let i = 0; i < 11; i++) u32(0);
  const phxm = makeZip([
    { name: 'metadata.json', data: JSON.stringify(meta), method: 0 },
    { name: 'objects.phxmo', data: Buffer.concat(objs), method: 0 },
    { name: 'audio.mp3', data: FAKE_MP3, method: 0 },
  ]);
  assert.ok(looksLikePHXM(readZip(phxm)));
  const m = await parsePHXM(phxm);
  assert.equal(m.title, 'Tune');
  assert.equal(m.artist, 'Art');
  assert.equal(m.difficultyName, 'Insane');
  assert.deepEqual(m.notes, [{ t: 0.25, x: 1.5, y: 2 }, { t: 0.5, x: 0, y: 0 }, { t: 0.75, x: 1, y: 1 }]);
  assert.equal(m.audioMime, 'audio/mpeg');
});
