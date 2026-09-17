import { describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';

const manifest = (overrides = {}) => ({ schemaVersion: '0.1.0', id: 'tool/test', kind: 'tool', name: 'Test Tool', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' }, ...overrides });

function runtime(handler, options = {}) {
  const registry = new CapabilityRegistry();
  registry.register(manifest(options.manifest), handler);
  return new ToolRuntime({ registry, ...options });
}

describe('ToolRuntime', () => {
  it('executes registered tools with correlation and signal', async () => {
    const tool = vi.fn(async (input, context) => ({ value: input.value, aborted: context.signal.aborted }));
    const rt = runtime(tool, { idFactory: () => 'exec-1' });
    await expect(rt.execute('tool/test', { value: 42 })).resolves.toMatchObject({ executionId: 'exec-1', status: 'succeeded', output: { value: 42, aborted: false } });
    expect(tool).toHaveBeenCalledOnce();
  });

  it('rejects unavailable capabilities and non-tools', async () => {
    const registry = new CapabilityRegistry();
    const rt = new ToolRuntime({ registry, idFactory: () => 'exec-2' });
    await expect(rt.execute('missing')).resolves.toMatchObject({ error: { code: 'TOOL_UNAVAILABLE' } });
    registry.register(manifest({ id: 'model/test', kind: 'model' }), vi.fn());
    await expect(rt.execute('model/test')).resolves.toMatchObject({ error: { code: 'TOOL_UNAVAILABLE' } });
  });

  it('enforces policy before invoking the handler', async () => {
    const tool = vi.fn();
    const rt = runtime(tool, { policyEngine: { authorize: () => ({ allowed: false, reason: 'denied' }) }, idFactory: () => 'exec-3' });
    await expect(rt.execute('tool/test')).resolves.toMatchObject({ error: { code: 'FORBIDDEN', message: 'denied' } });
    expect(tool).not.toHaveBeenCalled();
  });

  it('propagates parent cancellation', async () => {
    const controller = new AbortController();
    const tool = vi.fn(async (_input, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('cancelled')), { once: true })));
    const rt = runtime(tool, { idFactory: () => 'exec-4' });
    const pending = rt.execute('tool/test', {}, { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
  });

  it('times out execution and bounds retained records', async () => {
    const rt = runtime(async (_input, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { maxRecords: 1, idFactory: (() => { let i = 0; return () => `exec-${++i}`; })() });
    await expect(rt.execute('tool/test', {}, { timeoutMs: 5 })).resolves.toMatchObject({ status: 'timed_out', error: { code: 'TIMED_OUT' } });
    await expect(rt.execute('tool/test', {}, { timeoutMs: 5 })).resolves.toMatchObject({ executionId: 'exec-2' });
    expect(rt.listExecutions()).toHaveLength(1);
  });

  it('prevents execution id reuse', async () => {
    const rt = runtime(async () => 'ok', { idFactory: () => 'same' });
    await rt.execute('tool/test');
    await expect(rt.execute('tool/test')).resolves.toMatchObject({ error: { code: 'EXECUTION_CONFLICT' } });
  });
});
