// worker_threads evaluator for tools/train.mjs
import { parentPort } from 'node:worker_threads';
import { evaluateCandidates, registerTrainingMap } from '../src/ai/trainer.js';

parentPort.on('message', (msg) => {
  if (msg.type === 'map') {
    registerTrainingMap(msg.key, msg.packed);
    return;
  }
  const { id, arch, candidates, episodes, hand } = msg;
  const res = evaluateCandidates(arch, candidates, episodes, hand);
  parentPort.postMessage({ id, ...res });
});
