import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionPlanExecutor, ExecutionRecovery, ExecutionStateStore, FileExecutionStateStore } from '../src/index.js';

function plan() {
  return {
    schemaVersion: '0.1.0',
    type: 'execution-plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    root: 'capability/final',
    stepCount: 2,
    steps: [
      { step: 1, capabilityId: 'capability/prepare', kind: 'tool', domain: 'software', version: '1.0.0', requires: [], execution: 'dependency' },
      { step: 2, capabilityId: 'capability/final', kind: 'tool', domain: 'software', version: '1.0.0', requires: [], execution: 'root' }
    ],
    metadata: { deterministic: true, duplicateDependencies: [] }
  };
}

test('state store enforces optimistic concurrency and preserves immutable snapshots', async () => {
  const store = new ExecutionStateStore();
  const created = await store.create({ schemaVersion: '0.1.0', type: 'execution-state', executionId: 'exec_state_1', kind: 'plan', status: 'running' });
  assert.equal(created.version, 0);
  const updated = await store.update(created.executionId, { status: 'failed' }, created.version);
  assert.equal(updated.version, 1);
  await assert.rejects(() => store.update(created.executionId, { status: 'running' }, created.version), { code: 'EXECUTION_STATE_CONFLICT' });
  assert.equal((await store.get(created.executionId)).status, 'failed');
});

test('file state store survives recreation with the same versioned state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'super-state-'));
  try {
    const filePath = path.join(root, 'execution-state.json');
    const first = new FileExecutionStateStore(filePath);
    const created = await first.create({ schemaVersion: '0.1.0', type: 'execution-state', executionId: 'exec_file_1', kind: 'mission', status: 'running', missionId: 'mission/test' });
    await first.update(created.executionId, { status: 'succeeded', output: { ok: true } }, created.version);
    const second = new FileExecutionStateStore(filePath);
    const restored = await second.get(created.executionId);
    assert.equal(restored.version, 1);
    assert.equal(restored.status, 'succeeded');
    assert.deepEqual(restored.output, { ok: true });
    assert.match(await readFile(filePath, 'utf8'), /exec_file_1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan execution records a recovery cursor and resumes only the failed step', async () => {
  const stateStore = new ExecutionStateStore();
  const calls = [];
  let failFinal = true;
  const executionEngine = {
    async execute(capabilityId, input, context) {
      calls.push({ capabilityId, input, context });
      if (capabilityId === 'capability/prepare') return { status: 'succeeded', output: { prepared: true }, verification: { verified: true } };
      if (failFinal) return { status: 'failed', error: { code: 'TEMPORARY_FAILURE', message: 'retry me', retryable: true } };
      return { status: 'succeeded', output: { done: true }, verification: { verified: true } };
    }
  };
  const executor = new ExecutionPlanExecutor({ executionEngine, stateStore });
  const recovery = new ExecutionRecovery({ stateStore, planExecutor: executor });
  const first = await executor.execute(plan(), { request: 'x' }, { requestId: 'req-1' });

  assert.equal(first.status, 'failed');
  const state = await recovery.inspect(first.executionId);
  assert.equal(state.status, 'failed');
  assert.equal(state.nextStep, 2);
  assert.deepEqual(state.currentInput, { prepared: true });
  assert.equal(calls.length, 2);

  failFinal = false;
  const resumed = await recovery.resume(plan(), first.executionId, { requestId: 'req-1', resumed: true });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.resumed, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].capabilityId, 'capability/final');
  assert.equal(calls[2].input.prepared, true);
  assert.equal(calls[2].context.planStep, 2);
  assert.equal((await recovery.inspect(first.executionId)).attempt, 2);
  assert.equal((await recovery.listRecoverable()).length, 0);
});

test('concurrent resume attempts are serialized by the state version', async () => {
  const stateStore = new ExecutionStateStore();
  let calls = 0;
  const executionEngine = { async execute() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { status: 'succeeded', output: { done: true }, verification: { verified: true } }; } };
  const executor = new ExecutionPlanExecutor({ executionEngine, stateStore });
  const oneStepPlan = { ...plan(), steps: [{ ...plan().steps[0], capabilityId: 'capability/final' }], root: 'capability/final', stepCount: 1 };
  const failingEngine = { async execute() { return { status: 'failed', error: { code: 'RETRY', message: 'retry', retryable: true } }; } };
  const failingExecutor = new ExecutionPlanExecutor({ executionEngine: failingEngine, stateStore });
  const first = await failingExecutor.execute(oneStepPlan, {});
  const recovery = new ExecutionRecovery({ stateStore, planExecutor: executor });
  const [a, b] = await Promise.all([recovery.resume(oneStepPlan, first.executionId), recovery.resume(oneStepPlan, first.executionId)]);
  assert.equal([a, b].filter((result) => result.status === 'succeeded').length, 1);
  assert.equal([a, b].filter((result) => result.error?.code === 'EXECUTION_STATE_CONFLICT').length, 1);
  assert.equal(calls, 1);
});
