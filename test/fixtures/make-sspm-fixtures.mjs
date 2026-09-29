#!/usr/bin/env node
// Rebuilds the small .sspm fixtures in this folder from full-size test files, keeping every byte of the
// original layout (header, strings, custom data, marker definitions, markers, SHA-1) and replacing only the
// ~6.5 MB audio / cover blocks by tiny stand-ins (pointers are rewritten accordingly).
//
//   node test/fixtures/make-sspm-fixtures.mjs <dir containing t_v1.sspm t_v2_ssp.sspm t_v2_pysspm.sspm>
//
// The source files were written by (1) a byte-for-byte port of SS+ Song.gd convert_to_sspm_v1,
// (2) the same for convert_to_sspm (v2, with custom data + an extra marker type) and (3) the independent
// pysspm-rhythia writer, all with the 135 real notes (115 quantum) of an .rhm fixture (sspm_notes.json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TINY_AUDIO = Buffer.from('4944330300000000000000fffb90640000000000000000000000000000000000', 'hex'); // "ID3" + MPEG frame sync
export const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cff0ff3f0006fe02fe0c7589de0000000049454e44ae426082', 'hex');

function u64(buf, p) { return buf.readUInt32LE(p + 4) * 2 ** 32 + buf.readUInt32LE(p); }
function w64(buf, p, v) { buf.writeUInt32LE(v % 2 ** 32, p); buf.writeUInt32LE(Math.floor(v / 2 ** 32), p + 4); }

function shrinkV2(src) {
  const blocks = ['custom', 'audio', 'cover', 'markerDefs', 'markers'].map((name, i) => ({ name, i, off: u64(src, 0x30 + i * 16), len: u64(src, 0x38 + i * 16) }));
  const present = blocks.filter((b) => b.off > 0).sort((a, b) => a.off - b.off);
  const out = [];
  let pos = 0;
  const head = Buffer.from(src.subarray(0, present[0].off));
  out.push(head);
  pos = head.length;
  let prevEnd = present[0].off;
  for (const b of present) {
    if (b.off > prevEnd) { const gap = src.subarray(prevEnd, b.off); out.push(gap); pos += gap.length; }
    const data = b.name === 'audio' ? TINY_AUDIO : b.name === 'cover' ? TINY_PNG : src.subarray(b.off, b.off + b.len);
    b.newOff = pos;
    b.newLen = b.len ? data.length : 0;
    out.push(data);
    pos += data.length;
    prevEnd = b.off + b.len;
  }
  const res = Buffer.concat(out);
  for (const b of blocks) {
    if (!b.off) continue;
    w64(res, 0x30 + b.i * 16, b.newOff);
    w64(res, 0x38 + b.i * 16, b.newLen);
  }
  return res;
}

function shrinkV1(src) {
  let p = 8;
  for (let k = 0; k < 3; k++) p = src.indexOf(0x0a, p) + 1;
  p += 4 + 4 + 1; // last ms, note count, difficulty
  const parts = [src.subarray(0, p)];
  const coverType = src[p];
  parts.push(src.subarray(p, p + 1));
  p += 1;
  if (coverType === 2) {
    const len = u64(src, p);
    const l = Buffer.alloc(8); w64(l, 0, TINY_PNG.length);
    parts.push(l, TINY_PNG);
    p += 8 + len;
  } else if (coverType === 1) throw new Error('raw cover not supported here');
  const audioType = src[p];
  parts.push(src.subarray(p, p + 1));
  p += 1;
  if (audioType === 1) {
    const len = u64(src, p);
    const l = Buffer.alloc(8); w64(l, 0, TINY_AUDIO.length);
    parts.push(l, TINY_AUDIO);
    p += 8 + len;
  }
  parts.push(src.subarray(p));
  return Buffer.concat(parts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.log('usage: node test/fixtures/make-sspm-fixtures.mjs <dir>'); process.exit(1); }
  const jobs = [['t_v1.sspm', 'sspm_v1.sspm', shrinkV1], ['t_v2_ssp.sspm', 'sspm_v2_ssp.sspm', shrinkV2], ['t_v2_pysspm.sspm', 'sspm_v2_pysspm.sspm', shrinkV2]];
  for (const [from, to, fn] of jobs) {
    const out = fn(fs.readFileSync(path.join(dir, from)));
    fs.writeFileSync(path.join(here, to), out);
    console.log(to, out.length, 'bytes');
  }
  const notes = JSON.parse(fs.readFileSync(path.join(dir, 't_notes.json'), 'utf8'));
  fs.writeFileSync(path.join(here, 'sspm_notes.json'), JSON.stringify(notes));
  console.log('sspm_notes.json', notes.length, 'notes ([x, y, ms], .sspm orientation)');
}
