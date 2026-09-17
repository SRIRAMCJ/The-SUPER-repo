import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeExecutionAdmission } from '../src/execution-admission.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';
import { RuntimeResourceGovernance } from '../src/resource-governance.js';

function setup() {
  const shutdown = new RuntimeShutdownAdmission({ idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
  const resources = new RuntimeResourceGovernance({ limits: { concurrency: 1 }, clock: () => new Date('2026-09-17T00:00:00.000Z') });
  const admission = new RuntimeExecutionAdmission({ shutdown, resources, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })(), clock: () => new Date('2026-09-17T00:00:00.000Z') });
  return { shutdown, resources, admission };
}

test('atomically admits execution across shutdown and resource boundaries', () => {
  const { admission, shutdown, resources } = setup();
  const result = admission.admit({ executionId: 'e1', resources: { concurrency: 1 }, metadata: { lane: 'interactive' } });
  assert.equal(result.executionId, 'e1');
  assert.equal(shutdown.isAdmitted('e1'), true);
  assert.equal(resources.allocation('e1').allocation.concurrency, 1);
});

test('rolls back shutdown admission when resource admission is denied', () => {
  const { admission, shutdown } = setup();
  admission.admit({ executionId: 'e1', resources: { concurrency: 1 } });
  assert.throws(() => admission.admit({ executionId: 'e2', resources: { concurrency: 1 } }), { code: 'RESOURCE_ADMISSION_DENIED' });
  assert.equal(shutdown.isAdmitted('e2'), false);
});

test('blocks admission after shutdown enters draining', () => {
  const { admission, shutdown } = setup();
  shutdown.beginDrain({ deadlineMs: 100 });
  assert.throws(() => admission.admit({ executionId: 'e1' }), { code: 'ADMISSION_CLOSED' });
});

test('releases both resource and shutdown reservations after execution', async () => {
  const { admission, shutdown, resources } = setup();
  const result = await admission.execute({ executionId: 'e1', resources: { concurrency: 1 }, handler: async ({ executionId }) => ({ executionId, ok: true }) });
  assert.equal(result.status, 'succeeded');
  assert.equal(shutdown.isAdmitted('e1'), false);
  assert.equal(resources.allocation('e1').allocation.concurrency, 0);
});

test('does not admit an already-cancelled execution', async () => {
  const { admission, shutdown } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => admission.execute({ executionId: 'e1', signal: controller.signal, handler: async () => 'never' }), { code: 'EXECUTION_CANCELLED' });
  assert.equal(shutdown.isAdmitted('e1'), false);
});

test('reconciles resource reservations before forced shutdown', () => {
  const { admission, shutdown, resources } = setup();
  admission.admit({ executionId: 'e1', resources: { concurrency: 1 } });
  admission.admit({ executionId: 'e2', resources: {} });
  const result = admission.forceStop({ reason: 'operator_abort' });
  assert.equal(result.state, 'stopped');
  assert.deepEqual(result.executions, ['e1', 'e2']);
  assert.equal(resources.totals().totals.concurrency, 0);
  assert.equal(resources.allocation('e1').allocation.concurrency, 0);
  assert.equal(resources.allocation('e2').allocation.concurrency, 0);
  assert.equal(shutdown.activeExecutions().length, 0);
  assert.equal(result.released[0].executionId, 'e1');
});

test('keeps admission records immutable and bounded', () => {
  const { admission } = setup();
  for (const id of ['e1', 'e2', 'e3']) {
    try { admission.admit({ executionId: id }); } finally { admission.release(id); }
  }
  assert.ok(Object.isFrozen(admission.history()));
  assert.ok(Object.isFrozen(admission.history()[0]));
});
