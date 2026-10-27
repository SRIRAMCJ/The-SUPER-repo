import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileEventJournal } from '../packages/runtime/src/index.js';

const samples = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(samples) || samples < 20 || samples > 1000) throw new TypeError('samples must be 20–1000');
const directory = await mkdtemp(path.join(os.tmpdir(), 'super-phase3-benchmark-'));

async function measure(count, work) {
  const durations = [];
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    const before = performance.now();
    await work(index);
    durations.push(performance.now() - before);
  }
  const elapsedMs = performance.now() - start;
  durations.sort((a, b) => a - b);
  return { medianMs: +durations[Math.floor(count / 2)].toFixed(2), p95Ms: +durations[Math.ceil(count * .95) - 1].toFixed(2), operationsPerSecond: +(count * 1000 / elapsedMs).toFixed(1) };
}

try {
  const journal = new FileEventJournal(directory, { maxRecords: samples + 1 });
  await journal.append({ type: 'warmup', id: -1 });
  const append = await measure(samples, (id) => journal.append({ type: 'benchmark', id }));
  let sequence = 0, hash = '0'.repeat(64);
  const incrementalRead = await measure(samples, async () => {
    const { events } = await journal.readFrom({ afterSequence: sequence, afterHash: hash, limit: 1 });
    if (events.length !== 1) throw new Error('incremental read failed');
    sequence = events[0].sequence;
    hash = events[0].hash;
  });
  const fullReplay = await measure(5, async () => {
    const result = await journal.replay({ limit: samples + 1 });
    if (result.events.length !== samples + 1) throw new Error('replay failed');
  });
  process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, samples,
    append, incrementalRead, fullReplay, replayRecords: samples + 1 }, null, 2)}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
