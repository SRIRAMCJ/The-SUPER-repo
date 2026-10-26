import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RuntimeRequestGuard, FileRateLimiter, DurableIdempotencyStore } from '../packages/runtime/src/index.js';

const samples = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(samples) || samples < 20 || samples > 1000) throw new TypeError('samples must be 20–1000');
const directory = await mkdtemp(path.join(os.tmpdir(), 'super-phase2-benchmark-'));

async function measure(work) {
  const durations = [];
  await work(-1);
  const start = performance.now();
  for (let index = 0; index < samples; index++) {
    const before = performance.now();
    await work(index);
    durations.push(performance.now() - before);
  }
  const elapsedMs = performance.now() - start;
  durations.sort((a, b) => a - b);
  return { medianMs: +durations[Math.floor(samples / 2)].toFixed(2), p95Ms: +durations[Math.ceil(samples * .95) - 1].toFixed(2), requestsPerSecond: +(samples * 1000 / elapsedMs).toFixed(1) };
}

try {
  const guard = new RuntimeRequestGuard({ maxRequests: samples + 2 });
  const limiter = new FileRateLimiter({ filePath: path.join(directory, 'rate.json'), maxRequests: samples + 2 });
  const store = await new DurableIdempotencyStore({ filePath: path.join(directory, 'idempotency.jsonl'), maxRecords: samples + 2 }).init();
  const result = { platform: process.platform, node: process.version, samples,
    localGuard: await measure(() => guard.admit({ method: 'GET', path: '/health', clientKey: 'benchmark' })),
    sharedRateLimit: await measure(() => limiter.consume('benchmark')),
    durableClaimComplete: await measure(async (index) => {
      const key = `benchmark-${index}`;
      const claim = await store.claim(key, 'fingerprint');
      if (claim.state !== 'claimed' || !await store.completeClaim(key, 'fingerprint', claim.record.claimToken, { status: 200 })) throw new Error('benchmark decision failed');
    }) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
