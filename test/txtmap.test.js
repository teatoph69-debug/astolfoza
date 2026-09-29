import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTxtMap, looksLikeTxtMap } from '../src/maps/txtmap.js';

test('audio id + notes, ms → s, sorted', () => {
  const m = parseTxtMap('6359218227,2|1|2452,1|1|2477,0|1|2502,2|2|500');
  assert.equal(m.audioId, '6359218227');
  assert.deepEqual(m.notes.map((n) => n.t), [0.5, 2.452, 2.477, 2.502]);
});

test('axes are inverted relative to .sspm / our grid (x 0 = right, y 0 = bottom in text maps)', () => {
  // Rhythia wiki: "Q or 7 for top left corner (2|2) … C or 3 for bottom right corner (0|0)"
  const m = parseTxtMap('1,2|2|0,0|0|1000,1|1|2000,2|0|3000,0|2|4000');
  assert.deepEqual(m.notes.map((n) => [n.x, n.y]), [
    [0, 0], // (2|2) top-left
    [2, 2], // (0|0) bottom-right
    [1, 1], // centre
    [0, 2], // (2|0) bottom-left
    [2, 0], // (0|2) top-right
  ]);
});

test('quantum floats, whitespace, BOM, trailing comma, rbxassetid prefix', () => {
  const m = parseTxtMap('﻿ rbxassetid://42 ,\n 0.5|1.25|100 , 2.1525886|-0.5|200,\r\n');
  assert.equal(m.audioId, '42');
  assert.deepEqual(m.notes, [{ t: 0.1, x: 1.5, y: 0.75 }, { t: 0.2, x: -0.152589, y: 2.5 }]);
});

test('no audio id is fine; malformed tokens are skipped and counted', () => {
  const m = parseTxtMap('1|1|100,garbage,1|1,2|2|300,x|1|400');
  assert.equal(m.audioId, '');
  assert.equal(m.notes.length, 2);
  assert.equal(m.skipped, 3);
});

test('non-maps are rejected with a Russian message', () => {
  assert.throws(() => parseTxtMap(''), /пустой/);
  assert.throws(() => parseTxtMap('Hello, this is a readme, not a map'), /не похоже на текстовую карту/);
  assert.throws(() => parseTxtMap('1,a|b|c,d|e|f'), (e) => e.code === 'MAP_FORMAT' && !!e.en);
});

test('content sniffing', () => {
  assert.equal(looksLikeTxtMap('123456,1|0|300,2|2|600'), true);
  assert.equal(looksLikeTxtMap('  7,0.5|1.5|10'), true);
  assert.equal(looksLikeTxtMap('just some text'), false);
  assert.equal(looksLikeTxtMap('ID3\u0003\u0000binary'), false);
});
