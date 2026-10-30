import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const trials = Number(process.argv[2] ?? 5);
const samples = Number(process.argv[3] ?? 200);
const concurrency = Number(process.argv[4] ?? 8);
if (!Number.isSafeInteger(trials) || trials < 3 || trials > 10 ||
    !Number.isSafeInteger(samples) || samples < 20 || samples > 200 ||
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new TypeError('Invalid repeated benchmark arguments');
const results = [];
for (let index = 0; index < trials; index++) {
  const { stdout } = await run(process.execPath, [new URL('./benchmark-phase4.mjs', import.meta.url).pathname, String(samples), String(concurrency)],
    { maxBuffer: 1000000, timeout: 120000 });
  const result = JSON.parse(stdout);
  if (result.storage !== 'postgresql' || result.samples !== samples || result.mutualTlsConcurrent.concurrency !== concurrency)
    throw new Error('Benchmark configuration mismatch');
  results.push({ sequentialP95Ms: result.mutualTls.p95Ms, concurrentP95Ms: result.mutualTlsConcurrent.p95Ms,
    concurrentMedianMs: result.mutualTlsConcurrent.medianMs, throughput: result.mutualTlsConcurrent.operationsPerSecond });
}
function summarize(key) {
  const values = results.map((item) => item[key]).sort((a, b) => a - b);
  return { min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1) };
}
process.stdout.write(`${JSON.stringify({ node: process.version, trials, samplesPerRoute: samples, concurrency,
  sequentialP95Ms: summarize('sequentialP95Ms'), concurrentP95Ms: summarize('concurrentP95Ms'),
  concurrentMedianMs: summarize('concurrentMedianMs'), throughput: summarize('throughput'), runs: results,
  note: 'Repeated CI loopback runs on one runner and one PostgreSQL service; not a cross-version controlled comparison or production SLO.' }, null, 2)}\n`);
