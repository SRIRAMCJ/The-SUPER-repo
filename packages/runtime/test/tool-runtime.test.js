import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, ToolRuntime } from '../src/index.js';
const manifest = (overrides = {}) => ({ schemaVersion: '0.1.0', id: 'tool/test', kind: 'tool', name: 'Test Tool', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' }, ...overrides });
function runtime(handler, options = {}) {
  const registry = new CapabilityRegistry(); registry.register(manifest(options.manifest), handler);
  return new ToolRuntime({ registry, ...options });
}
test('executes registered tools with execution ID and signal', async () => {
  let calls = 0;
  const rt = runtime(async (input, context) => { calls++; return { value: input.value, aborted: context.signal.aborted }; }, { idFactory: () => 'exec-1' });
  const result = await rt.execute('tool/test', { value: 42 });
  assert.equal(result.executionId, 'exec-1'); assert.equal(result.status, 'succeeded'); assert.deepEqual(result.output, { value: 42, aborted: false }); assert.equal(calls, 1);
});
test('rejects unavailable capabilities and non-tools with distinct execution IDs', async () => {
  const registry = new CapabilityRegistry(); const rt = new ToolRuntime({ registry });
  assert.equal((await rt.execute('missing')).error.code, 'TOOL_UNAVAILABLE');
  registry.register(manifest({ id: 'model/test', kind: 'model' }), () => {});
  assert.equal((await rt.execute('model/test')).error.code, 'INVALID_TOOL_KIND');
});
test('enforces policy before invoking the handler', async () => {
  let calls = 0; const rt = runtime(() => calls++, { policyEngine: { authorize: () => ({ allowed: false }) } });
  assert.equal((await rt.execute('tool/test')).error.code, 'FORBIDDEN'); assert.equal(calls, 0);
});
test('propagates parent cancellation without waiting for a cooperative handler', async () => {
  const controller = new AbortController(); let release;
  const rt = runtime(() => new Promise((resolve) => { release = resolve; }));
  const pending = rt.execute('tool/test', {}, { signal: controller.signal });
  await new Promise(setImmediate); controller.abort();
  assert.equal((await pending).status, 'cancelled'); release();
});
test('times out execution and bounds retained records', async () => {
  const rt = runtime(async (_input, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { maxRecords: 1 });
  assert.equal((await rt.execute('tool/test', {}, { timeoutMs: 5 })).status, 'timed_out');
  assert.equal((await rt.execute('tool/test', {}, { timeoutMs: 5 })).status, 'timed_out');
  assert.equal(rt.listExecutions().length, 1);
});
test('prevents execution id reuse after completion', async () => {
  const rt = runtime(async () => 'ok', { idFactory: () => 'same' });
  await rt.execute('tool/test'); assert.equal((await rt.execute('tool/test')).error.code, 'EXECUTION_CONFLICT');
});
test('reserves execution IDs before concurrent dispatch', async () => {
  let calls = 0; let release;
  const rt = runtime(async () => { calls++; return new Promise((r) => { release = r; }); });
  const first = rt.execute('tool/test', {}, { executionId: 'same' });
  assert.equal((await rt.execute('tool/test', {}, { executionId: 'same' })).error.code, 'EXECUTION_CONFLICT');
  assert.equal(calls, 1); release('ok'); assert.equal((await first).status, 'succeeded');
});
test('pre-cancelled requests never invoke handlers', async () => {
  let calls = 0; const rt = runtime(() => calls++); const controller = new AbortController(); controller.abort();
  assert.equal((await rt.execute('tool/test', {}, { signal: controller.signal })).status, 'cancelled'); assert.equal(calls, 0);
});
test('timed-out non-cooperative handlers keep their ID reserved after history eviction', async () => {
  let release; let calls = 0;
  const rt = runtime((input) => { calls++; return input.wait ? new Promise((r) => { release = r; }) : 'done'; }, { maxRecords: 1 });
  assert.equal((await rt.execute('tool/test', { wait: true }, { executionId: 'stuck', timeoutMs: 5 })).status, 'timed_out');
  await rt.execute('tool/test', {}, { executionId: 'other' });
  assert.equal(rt.getExecution('stuck'), null);
  assert.equal((await rt.execute('tool/test', {}, { executionId: 'stuck' })).error.code, 'EXECUTION_CONFLICT');
  assert.equal(calls, 2); release();
});
