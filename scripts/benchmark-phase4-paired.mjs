import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
if (!process.env.SUPER_TEST_POSTGRES_URL) throw new Error('A PostgreSQL test service is required');
const pairs = Number(process.argv[2] ?? 5);
const samples = Number(process.argv[3] ?? 100);
if (!Number.isSafeInteger(pairs) || pairs < 3 || pairs > 8 || !Number.isSafeInteger(samples) || samples < 20 || samples > 200) throw new TypeError('Invalid paired benchmark arguments');
const comparison = process.env.SUPER_BENCHMARK_COMPARE ?? 'audit';
if (!['audit', 'claim', 'nonce'].includes(comparison)) throw new TypeError('Invalid comparison');
const [baseline, candidate] = comparison === 'claim' ? ['explicit', 'implicit'] : comparison === 'nonce' ? ['separate', 'combined'] : ['split', 'combined'];
const modeKey = comparison === 'claim' ? 'claimMode' : comparison === 'nonce' ? 'nonceMode' : 'auditMode';
const results = [];
for (let index = 0; index < pairs; index++) {
  const order = index % 2 ? [candidate, baseline] : [baseline, candidate];
  const pair = {};
  for (const mode of order) {
    const { stdout } = await run(process.execPath, [new URL('./benchmark-phase4.mjs', import.meta.url).pathname, String(samples), '8'],
      { env: { ...process.env, SUPER_BENCHMARK_NONCE_MODE: comparison === 'nonce' ? mode : 'combined', SUPER_BENCHMARK_AUDIT_MODE: comparison === 'audit' ? mode : 'combined', SUPER_BENCHMARK_CLAIM_MODE: comparison === 'claim' ? mode : 'implicit' }, maxBuffer: 1000000, timeout: 120000 });
    const result = JSON.parse(stdout);
    if (result[modeKey] !== mode || result.samples !== samples || result.storage !== 'postgresql') throw new Error('Benchmark mode mismatch');
    pair[mode] = { p95Ms: result.mutualTlsConcurrent.p95Ms, throughput: result.mutualTlsConcurrent.operationsPerSecond };
  }
  results.push({ order, ...pair, p95DifferenceMs: +(pair[candidate].p95Ms - pair[baseline].p95Ms).toFixed(2),
    throughputDifference: +(pair[candidate].throughput - pair[baseline].throughput).toFixed(1) });
}
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
process.stdout.write(`${JSON.stringify({ node: process.version, comparison, baseline, candidate, pairs, samplesPerRoute: samples, concurrency: 8,
  medianPairedP95DifferenceMs: median(results.map((item) => item.p95DifferenceMs)),
  medianPairedThroughputDifference: median(results.map((item) => item.throughputDifference)), results,
  note: 'Negative p95 differences and positive throughput differences favor the candidate. Alternating paired runs on one CI service; no production SLO.' }, null, 2)}\n`);
