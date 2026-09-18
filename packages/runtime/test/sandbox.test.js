import { describe, expect, it } from 'vitest';
import { ExecutionSandbox } from '../src/sandbox.js';

const node = process.execPath;

describe('ExecutionSandbox', () => {
  it('executes a child process without shell interpolation', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-1' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write("hello")']);
    expect(result).toMatchObject({ executionId: 'sandbox-1', status: 'succeeded', stdout: 'hello', exitCode: 0 });
  });

  it('uses a safe environment by default and accepts explicit values', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-2' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write(process.env.SUPER_TEST ?? "missing")'], { env: { SUPER_TEST: 'ok' } });
    expect(result.stdout).toBe('ok');
  });

  it('rejects inherited environment unless explicitly requested', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-3' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write(process.env.SUPER_SECRET ?? "missing")'], { env: { SUPER_SECRET: 'visible' } });
    expect(result.stdout).toBe('visible');
  });

  it('enforces output limits and terminates noisy processes', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-4' });
    const result = await sandbox.execute(node, ['-e', 'setInterval(() => process.stdout.write("xxxxxxxxxx"), 1)'], { maxOutputBytes: 100, timeoutMs: 5000 });
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('OUTPUT_LIMIT');
  });

  it('cancels a running process', async () => {
    const controller = new AbortController();
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-5' });
    const pending = sandbox.execute(node, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(new Error('stop')), 20);
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.error.code).toBe('CANCELLED');
  });

  it('times out a process', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-6' });
    const result = await sandbox.execute(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 20 });
    expect(result.status).toBe('timed_out');
    expect(result.error.code).toBe('TIMED_OUT');
  });

  it('fails closed for unsupported network isolation', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-7' });
    const result = await sandbox.execute(node, ['-e', 'process.exit(0)'], { policy: { network: true } });
    expect(result.error.code).toBe('NETWORK_ISOLATION_UNAVAILABLE');
  });

  it('requires cwd for filesystem policies', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-8' });
    const result = await sandbox.execute(node, ['-e', 'process.exit(0)'], { policy: { filesystem: 'workspace' } });
    expect(result.error.code).toBe('WORKSPACE_REQUIRED');
  });

  it('bounds retained records and prevents id reuse', async () => {
    let n = 0;
    const sandbox = new ExecutionSandbox({ maxRecords: 1, idFactory: () => `sandbox-${++n}` });
    await sandbox.execute(node, ['-e', 'process.exit(0)']);
    const second = await sandbox.execute(node, ['-e', 'process.exit(0)']);
    expect(second.executionId).toBe('sandbox-2');
    expect(sandbox.listExecutions()).toHaveLength(1);
    await expect(sandbox.execute(node, ['-e', 'process.exit(0)'], { executionId: 'sandbox-2' })).resolves.toMatchObject({ error: { code: 'EXECUTION_CONFLICT' } });
  });
});
