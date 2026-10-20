import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/registry.js';
import { ExecutionEngine } from '../src/executor.js';
import { ExecutionPlanExecutor } from '../src/plan-executor.js';
import { ExecutionStateStore } from '../src/state.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';

const plan = { schemaVersion: '0.1.0', type: 'execution-plan', root: 'test/work', steps: [{ step: 1, capabilityId: 'test/work' }] };

test('plan and capability share the gate, retaining actual work after timeout', async () => {
  let finish;
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'test/work', kind: 'tool', name: 'Work', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' }, timeoutSeconds: 0.01 }, () => new Promise((resolve) => { finish = resolve; }));
  const gate = new RuntimeShutdownAdmission();
  const executionEngine = new ExecutionEngine({ registry, shutdownAdmission: gate });
  const executor = new ExecutionPlanExecutor({ executionEngine, shutdownAdmission: gate });
  const failed = await executor.execute(plan);
  assert.equal(failed.error.code, 'EXECUTION_TIMEOUT');
  assert.equal(gate.snapshot().activeCount, 1);
  gate.beginDrain({ deadlineMs: 1000 });
  assert.equal((await executor.execute(plan)).error.code, 'ADMISSION_CLOSED');
  const drained = gate.waitForDrain();
  finish('late');
  assert.equal((await drained).state, 'stopped');
});

test('resume denies before changing the state version', async () => {
  const gate = new RuntimeShutdownAdmission();
  const stateStore = new ExecutionStateStore();
  const executor = new ExecutionPlanExecutor({ shutdownAdmission: gate, stateStore, executionEngine: { execute: async () => ({ status: 'failed', error: { code: 'FAIL' } }) } });
  const first = await executor.execute(plan);
  const before = await stateStore.get(first.executionId);
  gate.beginDrain();
  const result = await executor.resume(plan, first.executionId);
  assert.equal(result.error.code, 'ADMISSION_CLOSED');
  assert.equal((await stateStore.get(first.executionId)).version, before.version);
});
