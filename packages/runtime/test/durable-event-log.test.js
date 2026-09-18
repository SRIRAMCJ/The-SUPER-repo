import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DurableEventLog } from '../src/index.js';

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'super-event-log-'));
  return { dir, filePath: path.join(dir, 'events.jsonl') };
}

test('durable event log survives restart and replays from a cursor', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const first = new DurableEventLog({ filePath, maxEvents: 10, maxSeen: 20 });
    await first.init();
    await first.append({ id: 'e1', type: 'execution.started' }, { sourceNodeId: 'node-a', sourceSequence: 4, fencingToken: 2 });
    await first.append({ id: 'e2', type: 'execution.completed', status: 'succeeded' }, { sourceNodeId: 'node-a', sourceSequence: 5, fencingToken: 2 });
    const second = new DurableEventLog({ filePath, maxEvents: 10, maxSeen: 20 });
    await second.init();
    assert.equal(second.snapshot().sequence, 2);
    assert.equal(second.get('e2').status, 'succeeded');
    assert.equal((await second.replay({ afterSequence: 1 }))[0].id, 'e2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event log atomically deduplicates concurrent writers and rejects stale source/fence', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const a = new DurableEventLog({ filePath, lockRetryMs: 1 });
    const b = new DurableEventLog({ filePath, lockRetryMs: 1 });
    await Promise.all([a.init(), b.init()]);
    const results = await Promise.all([
      a.append({ id: 'same', type: 'execution.started' }, { sourceNodeId: 'node-a', sourceSequence: 1, fencingToken: 4 }),
      b.append({ id: 'same', type: 'execution.started' }, { sourceNodeId: 'node-a', sourceSequence: 1, fencingToken: 4 }),
    ]);
    assert.equal(results.filter((r) => r.state === 'published').length, 1);
    const current = new DurableEventLog({ filePath });
    await current.init();
    assert.equal((await current.append({ id: 'old-fence', type: 'execution.progress' }, { sourceNodeId: 'node-a', sourceSequence: 2, fencingToken: 3 })).state, 'stale_fence');
    assert.equal((await current.append({ id: 'stale-seq', type: 'execution.progress' }, { sourceNodeId: 'node-a', sourceSequence: 1, fencingToken: 4 })).state, 'stale');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event log preserves source cursors after bounded compaction', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const log = new DurableEventLog({ filePath, maxEvents: 2, maxSeen: 4 });
    await log.init();
    await log.append({ id: 'a1', type: 'a' }, { sourceNodeId: 'node-a', sourceSequence: 10, fencingToken: 7 });
    await log.append({ id: 'b1', type: 'b' }, { sourceNodeId: 'node-b', sourceSequence: 20, fencingToken: 3 });
    await log.append({ id: 'a2', type: 'c' }, { sourceNodeId: 'node-a', sourceSequence: 11, fencingToken: 7 });
    const restarted = new DurableEventLog({ filePath, maxEvents: 2, maxSeen: 4 });
    await restarted.init();
    assert.equal(restarted.snapshot().sourceSequences['node-a'], 11);
    assert.equal(restarted.snapshot().sourceFencingTokens['node-a'], 7);
    assert.equal((await restarted.append({ id: 'a-stale', type: 'd' }, { sourceNodeId: 'node-a', sourceSequence: 10, fencingToken: 7 })).state, 'stale');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event log compaction is crash-safe and corruption is explicit', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const log = new DurableEventLog({ filePath, maxEvents: 10, maxSeen: 20 });
    await log.init();
    await log.append({ id: 'e1', type: 'execution.started' }, { sourceNodeId: 'node-a' });
    await log.compact();
    const content = await readFile(filePath, 'utf8');
    assert.match(content, /"op":"snapshot"/);
    await rm(filePath);
    await import('node:fs/promises').then(({ appendFile }) => appendFile(filePath, '{not-json}\\n'));
    const broken = new DurableEventLog({ filePath });
    await assert.rejects(() => broken.init(), (error) => error.code === 'EVENT_LOG_REPLAY_FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event log derives a digest from the retained durable source range', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const log = new DurableEventLog({ filePath, maxEvents: 10, maxSeen: 20 });
    await log.init();
    await log.append({ id: 'e1', type: 'execution.started', metadata: { attempt: 1 } }, { sourceNodeId: 'node-a', sourceSequence: 1, fencingToken: 2 });
    await log.append({ id: 'e2', type: 'execution.completed', status: 'succeeded', metadata: { attempt: 1 } }, { sourceNodeId: 'node-a', sourceSequence: 2, fencingToken: 2 });
    const first = await log.digestSourceRange({ sourceNodeId: 'node-a', fromSourceSequence: 1, toSourceSequence: 2 });
    assert.equal(first.valid, true);
    assert.match(first.digest, /^[a-f0-9]{64}$/);

    const restarted = new DurableEventLog({ filePath, maxEvents: 10, maxSeen: 20 });
    await restarted.init();
    const second = await restarted.digestSourceRange({ sourceNodeId: 'node-a', fromSourceSequence: 1, toSourceSequence: 2 });
    assert.equal(second.digest, first.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event log reports integrity ranges that were evicted by retention', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const log = new DurableEventLog({ filePath, maxEvents: 2, maxSeen: 4 });
    await log.init();
    await log.append({ id: 'e1', type: 'a' }, { sourceNodeId: 'node-a', sourceSequence: 1 });
    await log.append({ id: 'e2', type: 'b' }, { sourceNodeId: 'node-a', sourceSequence: 2 });
    await log.append({ id: 'e3', type: 'c' }, { sourceNodeId: 'node-a', sourceSequence: 3 });
    const result = await log.digestSourceRange({ sourceNodeId: 'node-a', fromSourceSequence: 1, toSourceSequence: 3 });
    assert.equal(result.code, 'INTEGRITY_RANGE_EXCEEDS_RETENTION');
    const missing = await log.digestSourceRange({ sourceNodeId: 'node-a', fromSourceSequence: 1, toSourceSequence: 2 });
    assert.equal(missing.code, 'INTEGRITY_RANGE_INCOMPLETE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event log exposes immutable snapshots', async () => {
  const { dir, filePath } = await tempFile();
  try {
    const log = new DurableEventLog({ filePath });
    await log.init();
    await log.append({ id: 'e1', type: 'a' }, { sourceNodeId: 'node-a' });
    const snapshot = log.snapshot();
    assert.throws(() => { snapshot.sourceSequences['node-a'] = 99; }, TypeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
