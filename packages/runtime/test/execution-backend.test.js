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

function backendHarness(capability) {
  const capabilities = new CapabilityRegistry();
  capabilities.register(capability, async () => {
    throw new Error('in-process handler must not be called for backend execution');
  });
  const sandbox = new ExecutionSandbox();
  const backends = new ExecutionBackendRegistry();
  backends.register('sandbox', new SandboxExecutionBackend({ sandbox }));
  return {
    engine: new ExecutionEngine({ registry: capabilities, backends }),
    sandbox,
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

test('SandboxExecutionBackend executes the immutable capability command and returns typed output', async () => {
  const capability = manifest('command.run', {
    backend: 'sandbox',
    command: node,
    args: ['-e', 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ received: JSON.parse(data).value + 1 })))'],
    output: 'json',
  });
  const { engine } = backendHarness(capability);
  const result = await engine.execute('command.run', { value: 41 });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.backend, 'sandbox');
  assert.deepEqual(result.output, { received: 42 });
  assert.equal(result.record.status, 'succeeded');
});

test('SandboxExecutionBackend ignores caller command and options overrides', async () => {
  const capability = manifest('command.bound', {
    backend: 'sandbox',
    command: node,
    args: ['-e', 'process.stdout.write("bound")'],
    output: 'text',
  });
  const { engine } = backendHarness(capability);
  const result = await engine.execute('command.bound', {
    command: 'attacker-controlled-command',
    args: ['--attacker'],
    options: { policy: { filesystem: 'workspace' }, cwd: process.cwd() },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 'bound');
});

test('SandboxExecutionBackend preserves capability policy instead of caller overrides', async () => {
  const capability = manifest('command.network', {
    backend: 'sandbox',
    command: node,
    args: ['-e', 'process.exit(0)'],
    output: 'text',
    policy: { network: true },
  });
  const { engine } = backendHarness(capability);
  const result = await engine.execute('command.network', {
    options: { policy: { network: false } },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NETWORK_ISOLATION_UNAVAILABLE');
});

test('ExecutionEngine propagates cancellation into the sandbox backend', async () => {
  const capability = manifest('command.wait', {
    backend: 'sandbox',
    command: node,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    output: 'text',
  });
  const { engine } = backendHarness(capability);
  const execution = engine.execute('command.wait', {}, { executionId: 'engine-cancel-1' });

  assert.equal(engine.cancel('engine-cancel-1', 'operator cancelled'), true);
  const result = await execution;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.record.status, 'cancelled');
});

test('ExecutionEngine fails closed when a declared backend is unavailable', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(manifest('command.run', {
    backend: 'sandbox',
    command: node,
    args: ['-e', 'process.exit(0)'],
    output: 'text',
  }), async () => 'unreachable');

  const engine = new ExecutionEngine({ registry: capabilities });
  const result = await engine.execute('command.run', { value: 1 });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXECUTION_BACKEND_UNAVAILABLE');
});

test('SandboxExecutionBackend rejects invalid JSON output without exposing raw untyped output', async () => {
  const capability = manifest('command.invalid-output', {
    backend: 'sandbox',
    command: node,
    args: ['-e', 'process.stdout.write("not-json")'],
    output: 'json',
  });
  const { engine } = backendHarness(capability);
  const result = await engine.execute('command.invalid-output', { value: 1 });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SANDBOX_OUTPUT_INVALID');
});
