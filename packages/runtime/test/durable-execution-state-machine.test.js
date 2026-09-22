import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionStateStore } from '../src/state.js';
import {
  DurableExecutionStateMachine,
  isValidExecutionTransition,
  allowedExecutionTransitions,
} from '../src/durable-execution-state-machine.js';

test('creates and durably advances execution lifecycle', async () => {
  const store = new ExecutionStateStore();
  const machine = new DurableExecutionStateMachine({ store, clock: () => '2026-09-22T00:00:00.000Z' });
  const created = await machine.create({ executionId: 'exec-1', metadata: { missionId: 'm1' } });
  assert.equal(created.state, 'created');
  const admitted = await machine.transition('exec-1', 'admitted');
  const prepared = await machine.transition('exec-1', 'prepared');
  const running = await machine.transition('exec-1', 'running');
  const succeeded = await machine.transition('exec-1', 'succeeded');
  assert.deepEqual([admitted.state, prepared.state, running.state, succeeded.state], ['admitted', 'prepared', 'running', 'succeeded']);
  assert.equal(succeeded.transitionCount, 4);
  assert.equal(await machine.isTerminal('exec-1'), true);
});

test('rejects illegal lifecycle jumps and terminal mutation', async () => {
  const store = new ExecutionStateStore();
  const machine = new DurableExecutionStateMachine({ store });
  await machine.create({ executionId: 'exec-2' });
  await assert.rejects(() => machine.transition('exec-2', 'running'), error => error.code === 'INVALID_EXECUTION_TRANSITION');
  await machine.transition('exec-2', 'admitted');
  await machine.transition('exec-2', 'prepared');
  await machine.transition('exec-2', 'running');
  await machine.transition('exec-2', 'succeeded');
  await assert.rejects(() => machine.transition('exec-2', 'failed'), error => error.code === 'INVALID_EXECUTION_TRANSITION');
});

test('uses optimistic concurrency to prevent stale transitions', async () => {
  const store = new ExecutionStateStore();
  const machine = new DurableExecutionStateMachine({ store });
  await machine.create({ executionId: 'exec-3' });
  const snapshot = await machine.snapshot('exec-3');
  await machine.transition('exec-3', 'admitted', { expectedVersion: snapshot.version });
  await assert.rejects(() => machine.transition('exec-3', 'prepared', { expectedVersion: snapshot.version }), error => error.code === 'EXECUTION_STATE_CONFLICT');
});

test('recovers failed executions through an explicit recovery state', async () => {
  const store = new ExecutionStateStore();
  const machine = new DurableExecutionStateMachine({ store });
  await machine.create({ executionId: 'exec-4' });
  await machine.transition('exec-4', 'admitted');
  await machine.transition('exec-4', 'prepared');
  await machine.transition('exec-4', 'running');
  const failed = await machine.transition('exec-4', 'failed', { error: { code: 'WORKER_LOST', retryable: true } });
  assert.equal(failed.lastError.code, 'WORKER_LOST');
  const recovered = await machine.recover('exec-4');
  assert.equal(recovered.state, 'recovered');
  assert.equal(isValidExecutionTransition('recovered', 'running'), true);
});

test('exposes deterministic transition graph', () => {
  assert.deepEqual(allowedExecutionTransitions('running'), ['succeeded', 'failed', 'cancelled', 'timed_out']);
  assert.equal(isValidExecutionTransition('succeeded', 'running'), false);
});
