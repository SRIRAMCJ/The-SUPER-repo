import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TlsWorkerClient, RemoteWorkerAuthenticator } from '../packages/runtime/src/index.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/verify-phase4-hosts.mjs config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const { nodes, capabilityId, samples = 200, concurrency = 8, maxP95Ms } = config;
if (!Array.isArray(nodes) || nodes.length !== 2 || nodes[0].nodeId === nodes[1].nodeId ||
    !Number.isSafeInteger(samples) || samples < 20 || samples > 2000 ||
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
    !Number.isFinite(maxP95Ms) || maxP95Ms <= 0 ||
    typeof capabilityId !== 'string' || !capabilityId) throw new TypeError('Invalid Phase 4 deployment configuration');
const secret = (await readFile(config.hmacKeyFile)).subarray(0);
if (secret.length < 32) throw new TypeError('HMAC key must be at least 32 bytes');
const ca = await readFile(config.caFile);
const key = await readFile(config.clientKeyFile);
const cert = await readFile(config.clientCertFile);
const clients = nodes.map((node) => {
  if (!node.host || !node.servername || !Number.isSafeInteger(node.port) ||
      !node.serverFingerprint256 || !node.nodeId) throw new TypeError('Invalid worker endpoint');
  return new TlsWorkerClient({ ...node, ca, key, cert,
    authenticator: new RemoteWorkerAuthenticator({ key: secret }) });
});
const runId = randomUUID();
const input = { value: runId };
const raced = await Promise.allSettled(clients.map((client) =>
  client.execute({ requestId: runId, capabilityId, input })));
const fulfilled = raced.filter((item) => item.status === 'fulfilled');
const denied = raced.filter((item) => item.status === 'rejected');
const accepted = new Set(['REMOTE_REQUEST_CONFLICT', 'REMOTE_IN_PROGRESS', 'REMOTE_RECOVERY_REQUIRED']);
if (fulfilled.length !== 1 || denied.length !== 1 || !accepted.has(denied[0].reason.code))
  throw new Error('Shared request identity did not yield exactly one execution and one rejection');
const durations = [];
let next = 0;
const started = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, samples) }, async () => {
  while (next < samples) {
    const index = next++;
    const before = performance.now();
    const value = `${runId}-${index}`;
    const result = await clients[index % 2].execute({
      requestId: value, capabilityId, input: { value } });
    if (result?.value !== value) throw new Error('Echo result mismatch');
    durations.push(performance.now() - before);
  }
}));
const elapsedMs = performance.now() - started;
durations.sort((a, b) => a - b);
const p95Ms = +(durations[Math.ceil(samples * .95) - 1]).toFixed(2);
const report = { nodeIds: nodes.map((node) => node.nodeId), samples, concurrency,
  crossNodeClaim: 'one accepted, one rejected',
  medianMs: +durations[Math.floor(samples / 2)].toFixed(2), p95Ms,
  requestsPerSecond: +(samples * 1000 / elapsedMs).toFixed(1), maxP95Ms,
  passed: p95Ms <= maxP95Ms };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
