import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';

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
  assert.deepEqual((await rt.execute('model/test')).error, { code: 'TOOL_UNAVAILABLE', message: 'Tool capability is unavailable' });
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
