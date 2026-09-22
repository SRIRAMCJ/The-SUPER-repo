import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRegistry } from '../src/registry.js';
import { ExecutionSandbox } from '../src/sandbox.js';
import { ToolRuntime } from '../src/tool-runtime.js';

const node = process.execPath;

const manifest = (overrides = {}) => ({
  schemaVersion: '0.1.0',
  id: 'tool/test',
  kind: 'tool',
  name: 'Test Tool',
  version: '1.0.0',
  status: 'stable',
  description: 'test',
  provenance: { sourceType: 'test' },
  ...overrides,
});

function runtime(handler, options = {}) {
  const registry = new CapabilityRegistry();
  registry.register(manifest(options.manifest), handler);
  return new ToolRuntime({ registry, ...options });
}

test('ToolRuntime executes registered tools with correlation and signal', async () => {
  let calls = 0;
  const tool = async (input, context) => {
    calls += 1;
    return { value: input.value, aborted: context.signal.aborted };
  };
  const rt = runtime(tool, { idFactory: () => 'exec-1' });
  const result = await rt.execute('tool/test', { value: 42 });
  assert.equal(result.executionId, 'exec-1');
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { value: 42, aborted: false });
  assert.equal(calls, 1);
});

test('ToolRuntime rejects unavailable capabilities and non-tools', async () => {
  const registry = new CapabilityRegistry();
  let execution = 0;
  const rt = new ToolRuntime({ registry, idFactory: () => `exec-${++execution}` });
  assert.deepEqual((await rt.execute('missing')).error, { code: 'TOOL_UNAVAILABLE', message: 'Tool capability is unavailable' });
  registry.register(manifest({ id: 'model/test', kind: 'model' }), () => undefined);
  assert.deepEqual((await rt.execute('model/test')).error, { code: 'INVALID_TOOL_KIND', message: 'Capability is not a tool: model/test' });
});

test('ToolRuntime enforces policy before invoking the handler', async () => {
  let calls = 0;
  const rt = runtime(() => { calls += 1; }, {
    policyEngine: { authorize: () => ({ allowed: false, reason: 'denied' }) },
    idFactory: () => 'exec-3',
  });
  const result = await rt.execute('tool/test');
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(result.error.message, 'denied');
  assert.equal(calls, 0);
});

test('ToolRuntime propagates parent cancellation', async () => {
  const controller = new AbortController();
  const tool = async (_input, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('cancelled')), { once: true });
  });
  const rt = runtime(tool, { idFactory: () => 'exec-4' });
  const pending = rt.execute('tool/test', {}, { signal: controller.signal });
  controller.abort(new Error('stop'));
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'CANCELLED');
});

test('ToolRuntime times out execution and bounds retained records', async () => {
  const rt = runtime(async (_input, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), {
    maxRecords: 1,
    idFactory: (() => { let i = 0; return () => `exec-${++i}`; })(),
  });
  const first = await rt.execute('tool/test', {}, { timeoutMs: 5 });
  assert.equal(first.status, 'timed_out');
  assert.equal(first.error.code, 'TIMED_OUT');
  const second = await rt.execute('tool/test', {}, { timeoutMs: 5 });
  assert.equal(second.executionId, 'exec-2');
  assert.equal(rt.listExecutions().length, 1);
});

test('ToolRuntime prevents execution id reuse', async () => {
  const rt = runtime(async () => 'ok', { idFactory: () => 'same' });
  await rt.execute('tool/test');
  const result = await rt.execute('tool/test');
  assert.equal(result.error.code, 'EXECUTION_CONFLICT');
});

test('ToolRuntime routes sandbox-backed tools through ExecutionSandbox and never invokes the in-process handler', async () => {
  let calls = 0;
  const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-tool-1' });
  const rt = runtime(() => { calls += 1; return { bypassed: true }; }, {
    sandbox,
    idFactory: () => 'tool-exec-1',
    manifest: {
      execution: {
        backend: 'sandbox',
        command: node,
        args: ['-e', 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ received: JSON.parse(data).value + 1 })))'],
        output: 'json',
      },
    },
  });

  const result = await rt.execute('tool/test', { value: 41 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { received: 42 });
  assert.equal(result.backend, 'sandbox');
  assert.equal(result.sandbox.executionId, 'tool-exec-1');
  assert.equal(calls, 0);
});

test('ToolRuntime fails closed when a sandbox backend is declared without a sandbox', async () => {
  const rt = runtime(() => 'must-not-run', {
    idFactory: () => 'tool-exec-2',
    manifest: { execution: { backend: 'sandbox', command: node, args: ['-e', 'process.stdout.write("{}")]'] } },
  });
  const result = await rt.execute('tool/test');
  assert.equal(result.error.code, 'SANDBOX_UNAVAILABLE');
});

test('ToolRuntime preserves policy as the security boundary before sandbox execution', async () => {
  let calls = 0;
  const sandbox = { execute: async () => { calls += 1; return { status: 'succeeded', stdout: '{}' }; } };
  const rt = runtime(() => undefined, {
    sandbox,
    policyEngine: { authorize: () => ({ allowed: false, reason: 'sandbox denied by policy' }) },
    idFactory: () => 'tool-exec-3',
    manifest: { execution: { backend: 'sandbox', command: node, args: ['-e', 'process.stdout.write("{}")'] } },
  });
  const result = await rt.execute('tool/test');
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(calls, 0);
});

test('ToolRuntime propagates sandbox cancellation and timeout as terminal tool states', async () => {
  const sandbox = new ExecutionSandbox();
  const cancel = new AbortController();
  const rt = runtime(() => undefined, {
    sandbox,
    idFactory: (() => { let i = 0; return () => `tool-exec-${++i}`; })(),
    manifest: {
      execution: {
        backend: 'sandbox',
        command: node,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        output: 'text',
      },
    },
  });

  const pending = rt.execute('tool/test', {}, { signal: cancel.signal, timeoutMs: 5000 });
  cancel.abort(new Error('stop'));
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error.code, 'CANCELLED');

  const timed = await rt.execute('tool/test', {}, { timeoutMs: 20 });
  assert.equal(timed.status, 'timed_out');
  assert.equal(timed.error.code, 'TIMED_OUT');
});

test('ToolRuntime rejects invalid sandbox output instead of returning untyped data', async () => {
  const sandbox = new ExecutionSandbox();
  const rt = runtime(() => undefined, {
    sandbox,
    manifest: {
      execution: {
        backend: 'sandbox',
        command: node,
        args: ['-e', 'process.stdout.write("not-json")'],
        output: 'json',
      },
    },
  });
  const result = await rt.execute('tool/test');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SANDBOX_OUTPUT_INVALID');
});
