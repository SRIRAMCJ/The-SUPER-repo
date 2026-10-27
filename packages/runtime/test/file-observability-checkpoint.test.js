import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileEventJournal, FileObservabilityCheckpoint, ObservabilityEngine } from '../src/index.js';

async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-observability-checkpoint-'));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('checkpoint restores lifetime metrics after compaction and validates the anchor', () => temporary(async (directory) => {
  const journal = new FileEventJournal(path.join(directory, 'journal'));
  await journal.append({ type: 'execution.started', executionId: 'run', timestamp: '2026-01-01T00:00:00.000Z' });
  const completed = await journal.append({ type: 'execution.completed', executionId: 'run', timestamp: '2026-01-01T00:00:01.000Z' });
  const engine = new ObservabilityEngine();
  await engine.syncFromJournal(journal);
  const checkpoint = new FileObservabilityCheckpoint(path.join(directory, 'projection.json'));
  assert.deepEqual(await checkpoint.save(engine), { sequence: 2, hash: completed.hash });
  await journal.compactThrough(2, completed.hash);
  await journal.append({ type: 'execution.failed', executionId: 'another' });
  const restored = ObservabilityEngine.restoreCheckpoint(await checkpoint.load());
  assert.equal((await restored.syncFromJournal(journal)).applied, 1);
  const metrics = new Map(restored.getMetrics().metrics.map((item) => [item.name, item.value]));
  assert.equal(metrics.get('executions.started'), 1);
  assert.equal(metrics.get('executions.completed'), 1);
  assert.equal(metrics.get('executions.failed'), 1);
  assert.equal(restored.getTraces()[0].durationMs, 1000);
  await checkpoint.save(restored);
  await assert.rejects(checkpoint.save(engine), { code: 'OBSERVABILITY_CHECKPOINT_STALE' });
}));

test('missing and altered checkpoint fail closed', () => temporary(async (directory) => {
  const journal = new FileEventJournal(path.join(directory, 'journal'));
  await journal.append({ type: 'execution.started' });
  const engine = new ObservabilityEngine();
  await engine.syncFromJournal(journal);
  const file = path.join(directory, 'projection.json');
  const checkpoint = new FileObservabilityCheckpoint(file);
  await checkpoint.save(engine);
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('execution.started', 'execution.failed'));
  await assert.rejects(checkpoint.load(), { code: 'OBSERVABILITY_CHECKPOINT_CORRUPT' });
  await writeFile(file, original);
  await unlink(file);
  await assert.rejects(new FileObservabilityCheckpoint(file).load(), { code: 'OBSERVABILITY_CHECKPOINT_MISSING' });
}));
