import test from 'node:test';
import assert from 'node:assert/strict';
import { MeasuredProcessRuntime, createMeasuredProcessHandler } from '../src/measured-process.js';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';

const root = new URL('../fixtures/', import.meta.url).pathname;
const modulePath = 'worker-budget-fixture.js';
const budget = { cpuMs: 1000, heapBytes: 64 * 1024 * 1024, wallMs: 1500 };

test('child returns output with measured worker CPU and JS heap', async () => {
  const runtime = new MeasuredProcessRuntime({ root });
  const result = await runtime.execute({ modulePath, exportName: 'echo', input: { value: 4 }, ...budget });
  assert.deepEqual(result.output, { value: 5 });
  assert.ok(result.usage.cpuMs > 0);
  assert.ok(result.usage.heapBytes > 0);
  assert.equal(runtime.activeCount(), 0);
});

test('CPU and wall deadline terminate offending children', async () => {
  const runtime = new MeasuredProcessRuntime({ root, sampleMs: 5 });
  await assert.rejects(runtime.execute({ modulePath, exportName: 'spin', ...budget, cpuMs: 30 }), { code: 'PROCESS_CPU_LIMIT' });
  await assert.rejects(runtime.execute({ modulePath, exportName: 'wait', ...budget, wallMs: 30 }), { code: 'PROCESS_WALL_LIMIT' });
  assert.equal(runtime.activeCount(), 0);
});

test('memory budget terminates a child without crashing the parent', async () => {
  const runtime = new MeasuredProcessRuntime({ root, sampleMs: 5 });
  await assert.rejects(runtime.execute({ modulePath, exportName: 'allocate', ...budget, heapBytes: 16 * 1024 * 1024 }), (error) => ['PROCESS_HEAP_LIMIT', 'PROCESS_WORKER_FAILED', 'PROCESS_WORKER_EXITED', 'PROCESS_EXITED'].includes(error.code));
  assert.equal((await runtime.execute({ modulePath, exportName: 'echo', input: { value: 1 }, ...budget })).output.value, 2);
});

test('Linux RSS cap catches native Buffer allocation outside JS heap', { skip: process.platform !== 'linux' }, async () => {
  const runtime = new MeasuredProcessRuntime({ root, sampleMs: 5 });
  const baseline = await runtime.execute({ modulePath, exportName: 'echo', input: { value: 1 }, ...budget, rssBytes: 256 * 1024 * 1024 });
  assert.ok(baseline.usage.rssBytes > 0);
  await assert.rejects(runtime.execute({ modulePath, exportName: 'allocateNative', ...budget,
    heapBytes: 256 * 1024 * 1024, rssBytes: Math.max(64 * 1024 * 1024, baseline.usage.rssBytes + 32 * 1024 * 1024) }), { code: 'PROCESS_RSS_LIMIT' });
  assert.equal(runtime.activeCount(), 0);
});

test('concurrency and path confinement reject excess or external work', async () => {
  const runtime = new MeasuredProcessRuntime({ root, maxConcurrent: 1 });
  const first = runtime.execute({ modulePath, exportName: 'wait', ...budget });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(runtime.execute({ modulePath, exportName: 'wait', ...budget }), { code: 'PROCESS_CONCURRENCY_LIMIT' });
  assert.equal((await first).output, 'done');
  await assert.rejects(runtime.execute({ modulePath: '../src/index.js', exportName: 'echo', ...budget }), /inside root/);
  assert.equal(runtime.activeCount(), 0);
});

test('tool runtime can explicitly dispatch through measured process and abort its child', async () => {
  const runtime = new MeasuredProcessRuntime({ root, sampleMs: 5 });
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'tool/measured', kind: 'tool', name: 'Measured', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' } },
    createMeasuredProcessHandler(runtime, { modulePath, exportName: 'wait', ...budget }));
  const tool = new ToolRuntime({ registry });
  const result = await tool.execute('tool/measured', {}, { executionId: 'timed', timeoutMs: 50 });
  assert.equal(result.status, 'timed_out');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.activeCount(), 0);
  assert.equal(runtime.history().at(-1).code, 'PROCESS_CANCELLED');
});
