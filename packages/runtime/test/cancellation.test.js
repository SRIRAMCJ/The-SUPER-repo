import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, ExecutionCancellationRegistry, ExecutionEngine } from '../src/index.js';

function capability(id, timeoutSeconds) {
  return {
    schemaVersion: '0.1.0',
    id,
    kind: 'tool',
    name: id,
    version: '1.0.0',
    status: 'stable',
    description: 'test capability',
    provenance: { sourceType: 'test' },
    ...(timeoutSeconds ? { timeoutSeconds } : {})
  };
}

test('execution can be cancelled externally and propagates an abort signal', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  const cancellation = new ExecutionCancellationRegistry();
  const engine = new ExecutionEngine({ registry, events, cancellation });
  let startedResolve;
  let readyResolve;
  const startedPromise = new Promise((resolve) => { startedResolve = resolve; });
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  let aborted = false;

  events.on('execution.started', startedResolve);
  events.on('execution.progress', readyResolve);
  registry.register(capability('capability/wait'), async (_input, { signal, emit }) => {
    emit({ phase: 'ready' });
    await new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    });
    throw signal.reason;
  });

  const executionPromise = engine.execute('capability/wait');
  const started = await startedPromise;
  await readyPromise;
  assert.equal(engine.cancel(started.executionId, 'user requested cancellation'), true);
  const result = await executionPromise;

  assert.equal(aborted, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXECUTION_CANCELLED');
  assert.equal(engine.cancel(started.executionId), false);
  assert.equal(cancellation.has(started.executionId), false);
});

test('cancellation remains distinct from timeout', async () => {
  const registry = new CapabilityRegistry();
  const engine = new ExecutionEngine({ registry });
  registry.register(capability('capability/timeout', 0.01), async () => new Promise(() => {}));
  const result = await engine.execute('capability/timeout');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXECUTION_TIMEOUT');
});
