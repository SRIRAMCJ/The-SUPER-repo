import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CapabilityRegistry,
  ExecutionBackendRegistry,
  ExecutionEngine,
  ExecutionSandbox,
  SandboxExecutionBackend,
} from '../src/index.js';

const node = process.execPath;

function manifest(id, execution) {
  return {
    schemaVersion: '0.1.0',
    id,
    kind: 'tool',
    name: id,
    version: '1.0.0',
    status: 'stable',
    description: id,
    provenance: { sourceType: 'test' },
    ...(execution ? { execution } : {}),
  };
}

test('ExecutionBackendRegistry registers and resolves execution backends', () => {
  const registry = new ExecutionBackendRegistry();
  const backend = { execute: async () => ({ status: 'succeeded' }) };
  assert.equal(registry.register('test', backend), 'test');
  assert.equal(registry.resolve('test'), backend);
  assert.deepEqual(registry.list(), ['test']);
  assert.throws(() => registry.require('missing'), /Execution backend not found/);
});

test('SandboxExecutionBackend translates a sandbox process into a backend result', async () => {
  const sandbox = new ExecutionSandbox({ idFactory: () => 'backend-1' });
  const backend = new SandboxExecutionBackend({ sandbox });
  const result = await backend.execute({
    executionId: 'backend-1',
    input: { command: node, args: ['-e', 'process.stdout.write("hello")'] },
    context: {},
    capability: manifest('command.run'),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.backend, 'sandbox');
  assert.equal(result.output.stdout, 'hello');
  assert.equal(result.record.executionId, 'backend-1');
});

test('ExecutionEngine routes declared sandbox capabilities through the backend', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(manifest('command.run', { backend: 'sandbox' }), async () => {
    throw new Error('handler must not be called for backend execution');
  });

  const sandbox = new ExecutionSandbox({ idFactory: () => 'engine-backend-1' });
  const backends = new ExecutionBackendRegistry();
  backends.register('sandbox', new SandboxExecutionBackend({ sandbox }));

  const engine = new ExecutionEngine({
    registry: capabilities,
    backends,
    clock: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const result = await engine.execute('command.run', {
    command: node,
    args: ['-e', 'process.stdout.write("backend-ok")'],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.backend, 'sandbox');
  assert.equal(result.output.stdout, 'backend-ok');
  assert.equal(result.record.status, 'succeeded');
});

test('ExecutionEngine propagates cancellation into the sandbox backend', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(manifest('command.wait', { backend: 'sandbox' }), async () => {
    throw new Error('handler must not be called');
  });

  const sandbox = new ExecutionSandbox({ idFactory: () => 'engine-cancel-1' });
  const backends = new ExecutionBackendRegistry();
  backends.register('sandbox', new SandboxExecutionBackend({ sandbox }));

  const engine = new ExecutionEngine({ registry: capabilities, backends });
  const execution = engine.execute('command.wait', {
    command: node,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  });

  for (let attempt = 0; attempt < 100 && !engine.cancellation?.has?.('engine-cancel-1'); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.cancel('engine-cancel-1', 'operator cancelled'), true);

  const result = await execution;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.record.status, 'cancelled');
});

test('ExecutionEngine fails closed when a declared backend is unavailable', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(manifest('command.run', { backend: 'sandbox' }), async () => 'unreachable');

  const engine = new ExecutionEngine({ registry: capabilities });
  const result = await engine.execute('command.run', { command: node, args: ['-e', 'process.exit(0)'] });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXECUTION_BACKEND_UNAVAILABLE');
});
