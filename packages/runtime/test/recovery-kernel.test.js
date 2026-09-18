import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeLifecycleManager } from '../src/lifecycle.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';
import { RuntimeReadinessKernel } from '../src/readiness.js';
import { RuntimeRecoveryKernel } from '../src/recovery-kernel.js';

function lifecycle() {
  return new RuntimeLifecycleManager({
    components: [{ name: 'core', start() {}, stop() {} }],
    clock: () => new Date('2026-01-01T00:00:00.000Z')
  });
}

function shutdown() {
  let id = 0;
  return new RuntimeShutdownAdmission({ clock: () => Date.now(), idFactory: (prefix) => `${prefix}-${++id}` });
}

test('coordinates drain, lifecycle restart, readiness, and admission reopen', async () => {
  const runtime = lifecycle();
  const admission = shutdown();
  await runtime.start();
  const readiness = new RuntimeReadinessKernel({ lifecycle: runtime, probes: { core: async () => true } });
  const recovery = new RuntimeRecoveryKernel({ lifecycle: runtime, shutdown: admission, readiness, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });

  const result = await recovery.recover({ deadlineMs: 100, pollMs: 1, reason: 'operator_restart' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.forced, false);
  assert.equal(runtime.snapshot().state, 'running');
  assert.equal(admission.state(), 'accepting');
  assert.equal(result.readiness.state, 'ready');
  assert.equal(recovery.state(), 'succeeded');
});

test('drain deadline forces admission cleanup before lifecycle restart', async () => {
  const runtime = lifecycle();
  const admission = shutdown();
  await runtime.start();
  admission.admit({ executionId: 'long-running' });
  const recovery = new RuntimeRecoveryKernel({ lifecycle: runtime, shutdown: admission, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });

  const result = await recovery.recover({ deadlineMs: 2, pollMs: 1, reason: 'deadline_recovery' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.forced, true);
  assert.deepEqual(result.drain.activeExecutions, []);
  assert.equal(admission.state(), 'accepting');
});

test('cancellation leaves the runtime safely draining instead of reopening admission', async () => {
  const runtime = lifecycle();
  const admission = shutdown();
  await runtime.start();
  admission.admit({ executionId: 'blocked' });
  const controller = new AbortController();
  const recovery = new RuntimeRecoveryKernel({ lifecycle: runtime, shutdown: admission });

  const pending = recovery.recover({ deadlineMs: 1000, pollMs: 5, signal: controller.signal });
  controller.abort();
  const result = await pending;

  assert.equal(result.status, 'cancelled');
  assert.equal(admission.state(), 'draining');
  assert.equal(runtime.snapshot().state, 'running');
});

test('serializes recovery attempts and retains bounded immutable history', async () => {
  const runtime = lifecycle();
  const admission = shutdown();
  await runtime.start();
  admission.admit({ executionId: 'hold' });
  const recovery = new RuntimeRecoveryKernel({ lifecycle: runtime, shutdown: admission, maxHistory: 2 });
  const pending = recovery.recover({ deadlineMs: 1000, pollMs: 5 });
  await assert.rejects(() => recovery.recover(), { code: 'RECOVERY_IN_PROGRESS' });
  admission.release('hold');
  await pending;

  const history = recovery.history();
  assert.equal(history.length, 2);
  assert.ok(Object.isFrozen(history));
  assert.ok(Object.isFrozen(history[0]));
});

test('reports lifecycle recovery failures without reopening admission', async () => {
  const runtime = lifecycle();
  const admission = shutdown();
  await runtime.start();
  const originalStart = runtime.start.bind(runtime);
  runtime.start = async () => { throw Object.assign(new Error('restart failed'), { code: 'RESTART_FAILED', retryable: true }); };
  const recovery = new RuntimeRecoveryKernel({ lifecycle: runtime, shutdown: admission });

  await assert.rejects(() => recovery.recover({ deadlineMs: 10 }), { code: 'RESTART_FAILED' });
  assert.equal(admission.state(), 'stopped');
  runtime.start = originalStart;
});
