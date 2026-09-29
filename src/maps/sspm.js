// .sspm parser (Sound Space Plus / Rhythia map format, versions 1 and 2).
//
// Byte layouts: see the SS+ source (Song.gd: convert_to_sspm*, load_from_sspm, read_notes, read_markers)
// and the spec at github.com/basils-garden/types (sspm/v1.md, sspm/v2.md). Everything little-endian.
//
// Coordinates: .sspm stores x 0 = left … 2 = right, y 0 = top … 2 = bottom (player's view) —
// exactly our grid space (core/constants.js), so positions are copied as is. Times: ms → seconds.
//
// Real-world pitfalls handled here (all seen in actual writers / readers):
//   * v2 custom-data pointer may be 0 (SSQE) → only read the block when offset AND length are non-zero;
//   * 64-bit offsets are read as two u32 (safe below 2^53);
//   * every marker definition ends with a 0x00 byte that must be consumed;
//   * markers that are not notes (other definitions) are decoded generically and skipped;
//   * quantum notes are f32 pairs (any value, may be negative / off-grid); on-grid notes are u8 pairs;
//   * v1 strings are "\n"-terminated lines that may carry a "\r";
//   * notes are not guaranteed to be sorted (v1) → sorted by (t, y, x) like SS+ `notesort`;
//   * spec erratum: v2 "has audio" is byte 0x2D and "has cover" is 0x2E.

export const SSPM_DIFFICULTY_NAMES = ['', 'Easy', 'Medium', 'Hard', 'Logic', 'Tasukete'];

const td = new TextDecoder('utf-8');

/** Error with a Russian message (shown to the user) and an English variant in `.en`. */
export function formatError(ru, en) {
  const e = new Error(ru);
  e.en = en;
  e.code = 'MAP_FORMAT';
  return e;
}

export function isSSPM(bytes) {
  const u8 = toU8(bytes);
  return u8.length >= 4 && u8[0] === 0x53 && u8[1] === 0x53 && u8[2] === 0x2b && u8[3] === 0x6d;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{version:number, id:string, name:string, songName:string, artist:string, title:string,
 *   mappers:string[], difficulty:number, difficultyName:string, rating:number, requiresMod:boolean,
 *   lastMs:number, notes:{t:number,x:number,y:number}[], audio:ArrayBuffer|null, audioMime:string|null,
 *   cover:ArrayBuffer|null, coverMime:string|null, customData:object, warnings:string[]}}
 */
export function parseSSPM(input) {
  const u8 = toU8(input);
  if (!isSSPM(u8)) {
    throw formatError('Это не файл .sspm (нет подписи "SS+m")', 'Not an .sspm file (missing "SS+m" signature)');
  }
  const r = new Reader(u8);
  r.p = 4;
  const version = r.u16();
  let out;
  try {
    if (version === 1) out = parseV1(r);
    else if (version === 2) out = parseV2(r);
    else throw formatError(`Неподдерживаемая версия .sspm: ${version}`, `Unsupported .sspm version: ${version}`);
  } catch (e) {
    if (e.code === 'MAP_FORMAT') throw e;
    if (e instanceof RangeError) {
      throw formatError('Файл .sspm обрезан или повреждён (данные заканчиваются раньше времени)',
        '.sspm file is truncated or corrupted (unexpected end of data)');
    }
    throw formatError(`Файл .sspm повреждён: ${e.message}`, `.sspm file is corrupted: ${e.message}`);
  }
  out.version = version;

  // notes: ms → s, drop non-finite garbage, sort like SS+ (time, then y, then x)
  const notes = [];
  for (const n of out.rawNotes) {
    if (!Number.isFinite(n.t) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (Math.abs(n.x) > 1000 || Math.abs(n.y) > 1000) continue;
    notes.push({ t: n.t / 1000, x: round6(n.x), y: round6(n.y) });
  }
  delete out.rawNotes;
  notes.sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x);
  if (!notes.length) throw formatError('В карте .sspm нет ни одной ноты', 'The .sspm map contains no notes');
  out.notes = notes;

  const custom = out.customData.difficulty_name;
  out.difficultyName = (typeof custom === 'string' && custom.trim()) || SSPM_DIFFICULTY_NAMES[out.difficulty] || '';
  const { artist, title } = songArtistTitle(out.songName, out.name);
  out.artist = artist;
  out.title = title;
  out.audioMime = out.audio ? sniffAudioMime(new Uint8Array(out.audio)) : null;
  out.coverMime = out.cover ? sniffImageMime(new Uint8Array(out.cover)) : null;
  if (out.cover && !out.coverMime) { out.cover = null; out.warnings.push('unknown cover image format'); }
  return out;
}

function parseV1(r) {
  const out = baseResult();
  if (r.u16() !== 0) throw formatError('Повреждённый заголовок .sspm v1 (reserved ≠ 0)', 'Corrupted .sspm v1 header (reserved ≠ 0)');
  out.id = r.line();
  out.name = r.line();
  out.songName = out.name;
  out.mappers = r.line().split(/\s*(?:&|,)\s*/).map((s) => s.trim()).filter(Boolean);
  out.lastMs = r.u32();
  const noteCount = r.u32();
  out.difficulty = clampDifficulty(r.u8());
  const coverType = r.u8();
  if (coverType === 1) {
    // raw Godot Image (obsolete): h, w, mipmaps, format, then u64 length + pixels — not displayable
    r.skip(6);
    r.skip(r.u64());
    out.warnings.push('raw Godot cover skipped');
  } else if (coverType === 2) {
    const len = r.u64();
    out.cover = r.bytes(len).slice().buffer;
  } else if (coverType !== 0) {
    throw formatError(`Неизвестный тип обложки в .sspm v1: ${coverType}`, `Unknown .sspm v1 cover type: ${coverType}`);
  }
  const audioType = r.u8();
  if (audioType === 1) {
    const len = r.u64();
    out.audio = r.bytes(len).slice().buffer;
  } else if (audioType !== 0) {
    throw formatError(`Неизвестный тип аудио в .sspm v1: ${audioType}`, `Unknown .sspm v1 audio type: ${audioType}`);
  }
  for (let i = 0; i < noteCount; i++) {
    if (r.p >= r.u8a.length) { out.warnings.push(`file ends after ${i} of ${noteCount} notes`); break; }
    try {
      const t = r.u32();
      const [x, y] = r.position();
      out.rawNotes.push({ t, x, y });
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      out.warnings.push(`file ends after ${i} of ${noteCount} notes`);
      break;
    }
  }
  return out;
}

function parseV2(r) {
  const out = baseResult();
  const len = r.u8a.length;
  if (r.u32() !== 0) throw formatError('Повреждённый заголовок .sspm v2 (reserved ≠ 0)', 'Corrupted .sspm v2 header (reserved ≠ 0)');
  r.skip(20); // SHA-1 of marker data — nobody validates it (SSQE writes zeros)
  out.lastMs = r.u32();
  const noteCount = r.u32();
  const markerCount = r.u32();
  out.difficulty = clampDifficulty(r.u8());
  out.rating = r.u16();
  const hasAudio = r.u8() === 1;
  const hasCover = r.u8() === 1;
  out.requiresMod = r.u8() === 1;
  const ptr = {};
  for (const k of ['custom', 'audio', 'cover', 'markerDefs', 'markers']) ptr[k] = { off: r.u64(), len: r.u64() };
  out.id = r.str16();
  out.name = r.str16();
  out.songName = r.str16();
  const mapperCount = r.u16();
  for (let i = 0; i < mapperCount; i++) out.mappers.push(r.str16());
  out.mappers = out.mappers.map((s) => s.trim()).filter(Boolean);

  const inFile = (b) => b.off > 0 && b.len > 0 && b.off + b.len <= len;

  // custom data (optional; failures here must not kill the import)
  if (ptr.custom.off && ptr.custom.len) {
    try {
      const c = new Reader(r.u8a);
      c.p = ptr.custom.off;
      const n = c.u16();
      for (let i = 0; i < n; i++) {
        const key = c.str16();
        const type = c.u8();
        const arrType = type === 0x0c ? c.u8() : 0;
        out.customData[key] = c.value(type, arrType);
      }
    } catch (e) {
      out.warnings.push('custom data unreadable: ' + e.message);
    }
  }

  if (hasAudio) {
    if (inFile(ptr.audio)) out.audio = r.u8a.slice(ptr.audio.off, ptr.audio.off + ptr.audio.len).buffer;
    else if (ptr.audio.len) out.warnings.push('audio block outside of the file (truncated?)');
  }
  if (hasCover) {
    if (inFile(ptr.cover)) out.cover = r.u8a.slice(ptr.cover.off, ptr.cover.off + ptr.cover.len).buffer;
    else if (ptr.cover.len) out.warnings.push('cover block outside of the file (truncated?)');
  }

  // marker definitions: u8 count, then { str16 name, u8 nvalues, u8 type × n, 0x00 }
  if (!ptr.markerDefs.off || ptr.markerDefs.off >= len) {
    throw formatError('Файл .sspm обрезан: нет блока с описанием нот', '.sspm file is truncated: marker definitions are missing');
  }
  r.p = ptr.markerDefs.off;
  const defs = [];
  const nd = r.u8();
  for (let i = 0; i < nd; i++) {
    const name = r.str16();
    const nv = r.u8();
    const types = [];
    for (let j = 0; j < nv; j++) types.push(r.u8());
    const term = r.u8();
    if (term !== 0) throw formatError('Повреждено описание маркеров .sspm', 'Corrupted .sspm marker definitions');
    defs.push({ name, types });
  }
  let noteDef = defs.findIndex((d) => d.name === 'ssp_note');
  if (noteDef < 0) noteDef = defs.findIndex((d) => d.types.length === 1 && d.types[0] === 0x07);
  if (noteDef < 0) throw formatError('В .sspm нет определения нот (ssp_note)', 'No note definition (ssp_note) in the .sspm file');

  // markers: u32 ms, u8 type index, values — bounded by the marker block end
  if (!ptr.markers.off || ptr.markers.off > len) {
    throw formatError('Файл .sspm обрезан: нет блока с нотами', '.sspm file is truncated: marker block is missing');
  }
  r.p = ptr.markers.off;
  const end = ptr.markers.len ? Math.min(len, ptr.markers.off + ptr.markers.len) : len;
  if (ptr.markers.off + ptr.markers.len > len) out.warnings.push('marker block is truncated');
  const count = markerCount || noteCount;
  for (let i = 0; i < count && r.p < end; i++) {
    const start = r.p;
    try {
      const t = r.u32();
      const ti = r.u8();
      const def = defs[ti];
      if (!def) { out.warnings.push(`unknown marker type ${ti} at byte ${start}; stopped`); break; }
      if (ti === noteDef) {
        const [x, y] = r.position();
        out.rawNotes.push({ t, x, y });
      } else {
        for (const ty of def.types) r.value(ty, 0); // decode generically, then drop
      }
    } catch (e) {
      if (!(e instanceof RangeError) && e.code !== 'BAD_VALUE') throw e;
      out.warnings.push(`marker data ends / breaks at byte ${start}`);
      break;
    }
    if (r.p > end) { out.rawNotes.length && out.warnings.push('marker ran past its block'); break; }
  }
  if (noteCount && out.rawNotes.length !== noteCount) {
    out.warnings.push(`header says ${noteCount} notes, read ${out.rawNotes.length}`);
  }
  return out;
}

function baseResult() {
  return {
    version: 0, id: '', name: '', songName: '', artist: '', title: '', mappers: [],
    difficulty: 0, difficultyName: '', rating: 0, requiresMod: false, lastMs: 0,
    rawNotes: [], notes: [], audio: null, audioMime: null, cover: null, coverMime: null,
    customData: {}, warnings: [],
  };
}

class Reader {
  constructor(u8a) {
    this.u8a = u8a;
    this.dv = new DataView(u8a.buffer, u8a.byteOffset, u8a.byteLength);
    this.p = 0;
  }
  need(n) {
    if (!(n >= 0) || this.p + n > this.u8a.length) throw new RangeError(`read past end @${this.p}+${n}`);
  }
  skip(n) { this.need(n); this.p += n; }
  u8() { this.need(1); return this.u8a[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  u64() {
    this.need(8);
    const lo = this.dv.getUint32(this.p, true), hi = this.dv.getUint32(this.p + 4, true);
    this.p += 8;
    return hi * 4294967296 + lo;
  }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  bytes(n) { this.need(n); const b = this.u8a.subarray(this.p, this.p + n); this.p += n; return b; }
  str16() { return td.decode(this.bytes(this.u16())); }
  line() {
    const s = this.p;
    const u = this.u8a;
    while (this.p < u.length && u[this.p] !== 0x0a) this.p++;
    if (this.p >= u.length) throw new RangeError('unterminated line');
    let str = td.decode(u.subarray(s, this.p));
    this.p++;
    const z = str.indexOf('\0');
    if (z >= 0) str = str.slice(0, z);
    return str.replace(/\r$/, '');
  }
  position() {
    const f = this.u8();
    if (f === 0) return [this.u8(), this.u8()];
    if (f === 1) return [this.f32(), this.f32()];
    const e = new Error(`bad position flag ${f}`);
    e.code = 'BAD_VALUE';
    throw e;
  }
  value(type, arrType) {
    switch (type) {
      case 0x01: return this.u8();
      case 0x02: return this.u16();
      case 0x03: return this.u32();
      case 0x04: return this.u64();
      case 0x05: return this.f32();
      case 0x06: return this.f64();
      case 0x07: return this.position();
      case 0x08: return this.bytes(this.u16()).slice();
      case 0x09: return this.str16();
      case 0x0a: return this.bytes(this.u32()).slice();
      case 0x0b: return td.decode(this.bytes(this.u32()));
      case 0x0c: {
        // array: u32 byte length (excluding itself), u16 count, values — skip by the byte length
        const byteLen = this.u32();
        const end = this.p + byteLen;
        this.need(byteLen);
        const n = this.u16();
        const arr = [];
        for (let i = 0; i < n && this.p < end; i++) arr.push(this.value(arrType, 0));
        this.p = end;
        return arr;
      }
      default: {
        const e = new Error(`unknown data type 0x${type.toString(16)}`);
        e.code = 'BAD_VALUE';
        throw e;
      }
    }
  }
}

// ---- shared helpers (also used by the other parsers / importer) ------------------------------

export function toU8(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  // always a plain Uint8Array view (Node's Buffer.slice() does not copy, Uint8Array's does)
  if (ArrayBuffer.isView(input)) {
    return input.constructor === Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw formatError('Ожидались двоичные данные файла', 'Expected binary file data');
}

/** "Artist - Title" → { artist, title } (first " - " wins; otherwise the whole string is the title). */
export function splitArtistTitle(s) {
  const str = String(s || '').trim();
  const i = str.indexOf(' - ');
  if (i > 0 && i < str.length - 3) return { artist: str.slice(0, i).trim(), title: str.slice(i + 3).trim() };
  return { artist: '', title: str };
}

/** Best artist/title from a song name and a map name (SS+ writes song = title only, name = "Artist - Title"). */
export function songArtistTitle(songName, mapName) {
  const a = splitArtistTitle(songName);
  if (a.artist) return a;
  const b = splitArtistTitle(mapName);
  if (b.artist) return b;
  return { artist: '', title: a.title || b.title };
}

export function sniffAudioMime(u8) {
  if (!u8 || u8.length < 4) return null;
  const s4 = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (s4 === 'OggS') return 'audio/ogg';
  if (s4 === 'fLaC') return 'audio/flac';
  if (s4 === 'RIFF' && u8.length >= 12 && String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'WAVE') return 'audio/wav';
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return 'audio/mpeg'; // ID3
  if (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync; layer bits 00 = AAC ADTS
    return (u8[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  if (u8.length >= 8 && String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp') return 'audio/mp4';
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'audio/webm';
  return null;
}

export function sniffImageMime(u8) {
  if (!u8 || u8.length < 4) return null;
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  if (u8[0] === 0x42 && u8[1] === 0x4d) return 'image/bmp';
  if (u8.length >= 12 && String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'RIFF' &&
      String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'WEBP') return 'image/webp';
  return null;
}

function clampDifficulty(d) { return d >= 0 && d <= 5 ? d : 0; }
function round6(v) { return Math.round(v * 1e6) / 1e6 + 0; } // + 0 turns -0 into 0
