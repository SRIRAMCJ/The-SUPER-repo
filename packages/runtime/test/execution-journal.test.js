import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionJournal, DurableExecutionState } from '../src/execution-journal.js';

test('ExecutionJournal durably appends newline-delimited records and replays after a new instance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-journal-'));
  const filePath = path.join(dir, 'transactions.jsonl');
  const journal = new ExecutionJournal({ filePath, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const first = await journal.append({ event: 'transaction.state', executionId: 'e1', transactionId: 't1', status: 'active' });
  assert.equal(first.timestamp, '2026-09-17T10:00:00.000Z');
  const journalAfterRestart = new ExecutionJournal({ filePath });
  const records = await journalAfterRestart.replay();
  assert.equal(records.length, 1);
  assert.equal(records[0].transactionId, 't1');
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true);
});

test('DurableExecutionState reconstructs latest transaction state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-state-'));
  const journal = new ExecutionJournal({ filePath: path.join(dir, 'journal.jsonl') });
  const state = new DurableExecutionState({ journal });
  await state.record({ executionId: 'e1', transactionId: 't1', status: 'active', operation: 'x', correlationId: 'c1' });
  await state.record({ executionId: 'e1', transactionId: 't1', status: 'committed', operation: 'x', correlationId: 'c1', result: { ok: true } });
  const loaded = await state.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].status, 'committed');
  assert.deepEqual(loaded[0].result, { ok: true });
});

test('journal redacts secret-shaped fields before persistence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-redact-'));
  const journal = new ExecutionJournal({ filePath: path.join(dir, 'journal.jsonl') });
  await journal.append({ event: 'x', executionId: 'e1', metadata: { apiKey: 'do-not-persist', nested: { token: 'also-secret' } } });
  const records = await journal.replay();
  assert.equal(records[0].metadata.apiKey, '[REDACTED]');
  assert.equal(records[0].metadata.nested.token, '[REDACTED]');
});

test('journal retention is bounded without losing the newest records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-retain-'));
  const journal = new ExecutionJournal({ filePath: path.join(dir, 'journal.jsonl'), maxRecords: 3 });
  for (let i = 0; i < 5; i++) await journal.append({ event: 'x', sequence: i });
  const records = await journal.replay();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(r => r.sequence), [2, 3, 4]);
});

test('journal rejects malformed replay records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-invalid-'));
  const journal = new ExecutionJournal({ filePath: path.join(dir, 'journal.jsonl') });
  await journal.append({ event: 'valid' });
  const fs = await import('node:fs/promises');
  await fs.appendFile(journal.filePath, '{bad-json}\n');
  await assert.rejects(() => journal.replay(), error => error.code === 'JOURNAL_REPLAY_FAILED');
});
