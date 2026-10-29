import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteCoordinationStore } from '../packages/runtime/src/sqlite-coordination.js';

const samples = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(samples) || samples < 20 || samples > 1000) throw new TypeError('samples must be 20–1000');
const dir = await mkdtemp(path.join(tmpdir(), 'super-sqlite-benchmark-'));
let store;
try {
  store = new SqliteCoordinationStore(path.join(dir, 'coordination.db'));
  const timings = [];
  for (let i = 0; i < samples; i++) {
    const before = performance.now();
    const lease = store.claim(`task-${i}`, 'host', 30000, 'a'.repeat(64));
    store.writeFencedEffect(`task-${i}`, lease, { value: i });
    timings.push(performance.now() - before);
  }
  timings.sort((a, b) => a - b);
  process.stdout.write(`${JSON.stringify({ samples, node: process.version, medianMs: +timings[Math.floor(samples / 2)].toFixed(2), p95Ms: +timings[Math.ceil(samples * .95) - 1].toFixed(2), note: 'Single-host synchronous SQLite claim plus fenced effect, not full worker request or multi-host capacity.' }, null, 2)}\n`);
} finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
