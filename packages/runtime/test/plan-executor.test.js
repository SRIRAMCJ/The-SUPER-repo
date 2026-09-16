import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ExecutionPlanExecutor } from '../src/index.js';

function plan(steps, root = steps.at(-1)?.capabilityId) {
  return { schemaVersion: '0.1.0', type: 'execution-plan', root, steps };
}

const step = (stepNumber, capabilityId) => ({
  step: stepNumber,
  capabilityId,
  kind: 'tool',
  domain: 'software',
  version: '1.0.0',
  requires: [],
  execution: stepNumber === 1 ? 'root' : 'dependency'
});

test('executes plan steps in order and chains output', async () => {
  const calls = [];
  const executionEngine = {
    async execute(capabilityId, input, context) {
      calls.push({ capabilityId, input, context });
      return { status: 'succeeded', output: `${input}|${capabilityId}`, verification: { verified: true } };
    }
  };
  const executor = new ExecutionPlanExecutor({ executionEngine, clock: () => new Date('2026-01-01T00:00:00.000Z') });
  const result = await executor.execute(plan([step(1, 'tool.a'), step(2, 'tool.root')]), 'input', { requestId: 'r1' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 'input|tool.a|tool.root');
  assert.equal(result.results.length, 2);
  assert.equal(calls[1].input, 'input|tool.a');
  assert.equal(calls[1].context.planStep, 2);
  assert.equal(calls[1].context.requestId, 'r1');
});

test('stops after the first failed step', async () => {
  let calls = 0;
  const executionEngine = {
    async execute() {
      calls += 1;
      return { status: 'failed', error: { code: 'STOP', message: 'failed', retryable: false } };
    }
  };
  const executor = new ExecutionPlanExecutor({ executionEngine });
  const result = await executor.execute(plan([step(1, 'tool.root')]));

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'STOP');
  assert.equal(calls, 1);
});

test('emits plan lifecycle events', async () => {
  const events = new EventBus();
  const observed = [];
  events.on('plan.started', (event) => observed.push(event.type));
  events.on('plan.completed', (event) => observed.push(event.type));
  const executionEngine = { async execute() { return { status: 'succeeded', output: 'ok' }; } };
  const executor = new ExecutionPlanExecutor({ executionEngine, events });

  await executor.execute(plan([step(1, 'tool.root')]));
  assert.deepEqual(observed, ['plan.started', 'plan.completed']);
});

test('rejects malformed or root-inconsistent plans', async () => {
  const executor = new ExecutionPlanExecutor({ executionEngine: { execute: async () => ({ status: 'succeeded', output: null }) } });
  await assert.rejects(() => executor.execute({ schemaVersion: '0.1.0', type: 'execution-plan', root: 'tool.other', steps: [step(1, 'tool.root')] }), /root must be the final step/);
  await assert.rejects(() => executor.execute({ schemaVersion: '0.1.0', type: 'execution-plan', root: 'tool.root', steps: [{ ...step(2, 'tool.root') }] }), /sequentially numbered/);
});
