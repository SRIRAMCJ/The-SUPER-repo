import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { FileFailoverStore, MeasuredProcessRuntime } from '../packages/runtime/src/index.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'super-phase1-benchmark-'));
const samples = Number(process.argv[2] ?? 12);
if (!Number.isSafeInteger(samples) || samples < 3 || samples > 100) throw new TypeError('samples must be 3–100');

async function measure(work) {
  const values = [];
  await work(-1);
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await work(i);
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { samples, medianMs: Number(values[Math.floor(values.length / 2)].toFixed(2)), p95Ms: Number(values[Math.ceil(values.length * 0.95) - 1].toFixed(2)) };
}

try {
  const store = new FileFailoverStore(path.join(directory, 'failover.json'));
  const root = fileURLToPath(new URL('../packages/runtime/fixtures/', import.meta.url));
  const runtime = new MeasuredProcessRuntime({ root });
  const budget = { modulePath: 'worker-budget-fixture.js', exportName: 'echo', input: { value: 1 }, cpuMs: 1000, heapBytes: 64 * 1024 * 1024, wallMs: 2000 };
  const result = { platform: process.platform, node: process.version, samples,
    leaseClaimRelease: await measure(async (i) => { const key = `benchmark-${i}`; const lease = await store.claim(key, 'benchmark'); await store.release(key, lease); }),
    measuredEcho: await measure(() => runtime.execute(budget)) };
  if (process.platform === 'linux') result.measuredEchoWithRss = await measure(() => runtime.execute({ ...budget, rssBytes: 256 * 1024 * 1024 }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
