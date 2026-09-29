#!/usr/bin/env node
// Headless trainer for МУХА. Uses all CPU cores via worker_threads.
//
//   node tools/train.mjs --gens 2000 --out checkpoints/muxa.json [--resume] [--hand pro]
//
// Periodically writes the session (same JSON format the browser uses for "Save brain"),
// plus snapshot brains whenever a new title (rank) is reached.

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrainingSession, titleFor } from '../src/ai/trainer.js';
import { HAND_PRESETS } from '../src/ai/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const gens = +(args.gens || 500);
const out = args.out || 'checkpoints/muxa.json';
const nWorkers = +(args.workers || os.cpus().length);
const hand = HAND_PRESETS[args.hand || 'pro'];
const seed = +(args.seed || 12345);
fs.mkdirSync(path.dirname(out), { recursive: true });

import { OBS_SIZE, ACT_SIZE } from '../src/ai/agent.js';
const hidden = String(args.hidden || '24,24').split(',').map(Number);
const sessionOpts = {
  hand, seed, arch: [OBS_SIZE, ...hidden, ACT_SIZE],
  es: { popSize: +(args.pop || 48), sigma: +(args.sigma || 0.04), lr: +(args.lr || 0.02) },
  episodesPerGen: +(args.eps || 6),
  episodeDur: +(args.dur || 8),
  benchEvery: +(args.bench || 10),
};

let session;
if (args.resume && fs.existsSync(out)) {
  session = TrainingSession.deserialize(JSON.parse(fs.readFileSync(out, 'utf8')), sessionOpts);
  if (args.rebench) {
    // the benchmark / curriculum changed: forget old scores so the champion is re-selected fairly
    session.bestSkill = -1;
    session.curriculum.level = Math.min(session.curriculum.level, +(args.rebench === true ? 10 : args.rebench));
    session.curriculum.ema = 0;
  }
  console.log(`resumed gen ${session.gen} level ${session.curriculum.level} skill ${session.skill.toFixed(2)}`);
} else {
  session = new TrainingSession(sessionOpts);
}

const workers = Array.from({ length: nWorkers }, () => new Worker(path.join(__dirname, 'train-worker.mjs')));
let reqId = 0;
function evalOn(worker, payload) {
  return new Promise((resolve) => {
    const id = ++reqId;
    const onMsg = (m) => { if (m.id === id) { worker.off('message', onMsg); resolve(m); } };
    worker.on('message', onMsg);
    worker.postMessage({ id, ...payload });
  });
}

async function evaluate(candidates, episodes) {
  const chunks = workers.map(() => []);
  candidates.forEach((c, i) => chunks[i % workers.length].push(i));
  const results = await Promise.all(workers.map((w, wi) => evalOn(w, {
    arch: session.arch, hand: session.hand, episodes,
    candidates: chunks[wi].map((i) => candidates[i]),
  })));
  const fitness = new Array(candidates.length), acc = new Array(candidates.length);
  results.forEach((r, wi) => chunks[wi].forEach((ci, k) => { fitness[ci] = r.fitness[k]; acc[ci] = r.acc[k]; }));
  return { fitness, acc };
}

const t0 = Date.now();
let lastTitle = titleFor(Math.max(0, session.bestSkill)).index;
const target = session.gen + gens;
while (session.gen < target) {
  const rec = await session.step(evaluate);
  if (rec.bench || rec.leveledUp || rec.gen % 10 === 0) {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`gen ${rec.gen} ${el}s level ${rec.level.toFixed(2)} acc ${(rec.acc * 100).toFixed(1)}% best ${(rec.bestAcc * 100).toFixed(1)}% fit ${rec.fitMean.toFixed(3)} skill ${rec.skill.toFixed(2)} (best ${rec.bestSkill.toFixed(2)})${rec.leveledUp ? ' LEVEL UP' : ''}${rec.bench ? ' ' + session.perLevel.map((p) => Math.round(p.acc * 100)).join('/') : ''}`);
  }
  const ti = titleFor(Math.max(0, session.bestSkill)).index;
  if (ti > lastTitle) {
    lastTitle = ti;
    const snap = out.replace(/\.json$/, `.rank${ti}.json`);
    fs.writeFileSync(snap, JSON.stringify(session.serialize()));
    console.log(`  >> new rank ${titleFor(session.bestSkill).ru} — snapshot ${snap}`);
  }
  if (rec.gen % 25 === 0) fs.writeFileSync(out, JSON.stringify(session.serialize()));
}
fs.writeFileSync(out, JSON.stringify(session.serialize()));
console.log('done', ((Date.now() - t0) / 1000).toFixed(0), 's');
await Promise.all(workers.map((w) => w.terminate()));
