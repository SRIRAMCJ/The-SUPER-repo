import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeExecutionTransactionKernel } from '../src/execution-transaction.js';

function makeAdmission() {
  const active = new Set();
  const releases = [];
  return {
    active, releases,
    async admit({ executionId }) { if (active.has(executionId)) throw new Error('duplicate'); active.add(executionId); return { executionId, state: 'running' }; },
    release(executionId, options) { active.delete(executionId); releases.push({ executionId, ...options }); return { released: true, executionId }; }
  };
}

test('begin and commit atomically own and release an execution admission', async () => {
  const admission = makeAdmission();
  let sequence = 0;
  const kernel = new RuntimeExecutionTransactionKernel({ admission, idFactory: (p) => `${p}-${++sequence}` });
  const tx = await kernel.begin({ executionId: 'e1', idempotencyKey: 'k1', resources: { cpuMs: 10 } });
  assert.equal(tx.status, 'active');
  assert.equal(admission.active.has('e1'), true);
  const committed = await kernel.commit(tx.transactionId, { value: 42 });
  assert.equal(committed.status, 'committed');
  assert.deepEqual(committed.result, { value: 42 });
  assert.equal(admission.active.size, 0);
  assert.equal(admission.releases[0].reason, 'transaction_committed');
});

test('idempotency replays a terminal transaction without rerunning work', async () => {
  const admission = makeAdmission();
  let calls = 0;
  const kernel = new RuntimeExecutionTransactionKernel({ admission, idFactory: (p) => `${p}-${++calls}` });
  const first = await kernel.execute({
    executionId: 'e1',
    idempotencyKey: 'same',
    handler: async () => ({ ok: true })
  });
  const second = await kernel.execute({
    executionId: 'e2',
    idempotencyKey: 'same',
    handler: async () => ({ ok: false })
  });
  assert.equal(first.status, 'committed');
  assert.equal(second.replayed, true);
  assert.equal(second.transactionId, first.transactionId);
  assert.deepEqual(second.result, { ok: true });
});

test('execution failure compensates in reverse registration order', async () => {
  const admission = makeAdmission();
  const kernel = new RuntimeExecutionTransactionKernel({ admission, idFactory: (() => { let n = 0; return p => `${p}-${++n}`; })() });
  const order = [];
  const result = await kernel.execute({
    executionId: 'e1',
    compensations: [
      async () => { order.push('first'); },
      { id: 'second', handler: async () => { order.push('second'); } },
      { id: 'third', handler: async () => { order.push('third'); } }
    ],
    handler: async () => { throw new Error('boom'); }
  });
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(order, ['third', 'second', 'first']);
  assert.equal(admission.active.size, 0);
});

test('compensation failure is isolated and surfaced as rollback_failed', async () => {
  const admission = makeAdmission();
  const kernel = new RuntimeExecutionTransactionKernel({ admission, idFactory: (() => { let n = 0; return p => `${p}-${++n}`; })() });
  const order = [];
  const result = await kernel.execute({
    executionId: 'e1',
    compensations: [
      { id: 'a', handler: async () => { order.push('a'); throw Object.assign(new Error('cannot undo'), { retryable: true }); } },
      { id: 'b', handler: async () => { order.push('b'); } }
    ],
    handler: async () => { throw new Error('boom'); }
  });
  assert.equal(result.status, 'rollback_failed');
  assert.equal(result.error.code, 'ROLLBACK_FAILED');
  assert.deepEqual(order, ['b', 'a']);
  assert.equal(admission.active.size, 0);
  assert.equal(result.compensationResults[1].error.code, 'COMPENSATION_FAILED');
});

test('AbortError rolls back and cancellation-aware compensation stops pending work', async () => {
  const admission = makeAdmission();
  const controller = new AbortController();
  const kernel = new RuntimeExecutionTransactionKernel({ admission, idFactory: (() => { let n = 0; return p => `${p}-${++n}`; })() });
  let ran = false;
  const result = await kernel.execute({
    executionId: 'e1',
    signal: controller.signal,
    compensations: [{ id: 'cleanup', handler: async () => { ran = true; } }],
    handler: async () => {
      controller.abort();
      const error = new Error('aborted'); error.name = 'AbortError'; throw error;
    }
  });
  assert.equal(result.status, 'rollback_failed');
  assert.equal(result.error.code, 'TRANSACTION_CANCELLED');
  assert.equal(ran, false);
  assert.equal(admission.active.size, 0);
});

test('active execution cannot create a duplicate transaction', async () => {
  const admission = makeAdmission();
  const kernel = new RuntimeExecutionTransactionKernel({ admission });
  const first = await kernel.begin({ executionId: 'e1' });
  const replay = await kernel.begin({ executionId: 'e1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.transactionId, first.transactionId);
  kernel.registerCompensation(first.transactionId, () => {}, { id: 'cleanup' });
  assert.throws(() => kernel.registerCompensation(first.transactionId, () => {}, { id: 'cleanup' }), /COMPENSATION/);
});

test('recover rolls an interrupted active transaction back and preserves immutable audit history', async () => {
  const admission = makeAdmission();
  const kernel = new RuntimeExecutionTransactionKernel({ admission, maxHistory: 4, idFactory: (() => { let n = 0; return p => `${p}-${++n}`; })() });
  const tx = await kernel.begin({ executionId: 'e1' });
  let compensated = false;
  kernel.registerCompensation(tx.transactionId, async () => { compensated = true; });
  const recovered = await kernel.recover(tx.transactionId);
  assert.equal(recovered.status, 'rolled_back');
  assert.equal(compensated, true);
  assert.equal(admission.active.size, 0);
  assert.equal(Object.isFrozen(kernel.history()), true);
  assert.equal(Object.isFrozen(kernel.history()[0]), true);
  assert.ok(kernel.history().length <= 4);
});

test('transaction state survives kernel restart through durable journal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-tx-durable-'));
  const { ExecutionJournal, DurableExecutionState } = await import('../src/execution-journal.js');
  const journal = new ExecutionJournal({ filePath: path.join(dir, 'journal.jsonl') });
  const durableState = new DurableExecutionState({ journal });
  const firstAdmission = makeAdmission();
  const firstKernel = new RuntimeExecutionTransactionKernel({ admission: firstAdmission, durableState, idFactory: (() => { let n = 0; return p => `${p}-${++n}`; })() });
  const tx = await firstKernel.execute({ executionId: 'e-durable', idempotencyKey: 'durable-key', handler: async () => ({ persisted: true }) });
  assert.equal(tx.status, 'committed');

  const secondKernel = new RuntimeExecutionTransactionKernel({ admission: makeAdmission(), durableState });
  const restored = await secondKernel.recoverDurable();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, 'committed');
  const replay = await secondKernel.execute({ executionId: 'another-execution', idempotencyKey: 'durable-key', handler: async () => ({ persisted: false }) });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, { persisted: true });
});
