import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionSandbox } from '../src/sandbox.js';

const node = process.execPath;

test('ExecutionSandbox', async (t) => {
  await t.test('executes a child process without shell interpolation', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-1' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write("hello")']);
    assert.deepEqual(
      { executionId: result.executionId, status: result.status, stdout: result.stdout, exitCode: result.exitCode },
      { executionId: 'sandbox-1', status: 'succeeded', stdout: 'hello', exitCode: 0 },
    );
  });

  await t.test('passes bounded UTF-8 stdin to the child process', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-stdin' });
    const result = await sandbox.execute(node, ['-e', 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(data))'], { stdin: 'தமிழ் 🚀' });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout, 'தமிழ் 🚀');
  });

  await t.test('fails closed when sandbox stdin exceeds the configured limit', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-input-limit' });
    const result = await sandbox.execute(node, ['-e', 'process.exit(0)'], { stdin: '123456', maxInputBytes: 5 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'INPUT_LIMIT');
  });

  await t.test('uses a safe environment by default and accepts explicit values', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-2' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write(process.env.SUPER_TEST ?? "missing")'], { env: { SUPER_TEST: 'ok' } });
    assert.equal(result.stdout, 'ok');
  });

  await t.test('does not inherit arbitrary host environment values by default', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-3' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write(process.env.SUPER_SECRET ?? "missing")'], { env: { SUPER_SECRET: 'visible' } });
    assert.equal(result.stdout, 'visible');
  });

  await t.test('does not inherit NODE_OPTIONS through the safe environment', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-3b' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write(process.env.NODE_OPTIONS ?? "missing")']);
    assert.equal(result.stdout, 'missing');
  });

  await t.test('enforces output limits and terminates noisy processes', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-4' });
    const result = await sandbox.execute(node, ['-e', 'setInterval(() => process.stdout.write("xxxxxxxxxx"), 1)'], { maxOutputBytes: 100, timeoutMs: 5000 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'OUTPUT_LIMIT');
  });

  await t.test('cancels a running process', async () => {
    const controller = new AbortController();
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-5' });
    const pending = sandbox.execute(node, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(new Error('stop')), 20);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.error.code, 'CANCELLED');
  });

  await t.test('times out a process', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-6' });
    const result = await sandbox.execute(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 20 });
    assert.equal(result.status, 'timed_out');
    assert.equal(result.error.code, 'TIMED_OUT');
  });

  await t.test('reports an independently terminated SIGTERM as a process failure', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-6b' });
    const result = await sandbox.execute(node, ['-e', 'process.kill(process.pid, "SIGTERM")']);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'PROCESS_EXIT');
  });

  await t.test('fails closed for unsupported network isolation', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-7' });
    const result = await sandbox.execute(node, ['-e', 'process.exit(0)'], { policy: { network: true } });
    assert.equal(result.error.code, 'NETWORK_ISOLATION_UNAVAILABLE');
  });

  await t.test('fails closed for unsupported workspace filesystem isolation', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-8' });
    const result = await sandbox.execute(node, ['-e', 'process.exit(0)'], { cwd: process.cwd(), policy: { filesystem: 'workspace' } });
    assert.equal(result.error.code, 'FILESYSTEM_ISOLATION_UNAVAILABLE');
  });

  await t.test('fails closed for unsupported read-only filesystem isolation', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-8b' });
    const result = await sandbox.execute(node, ['-e', 'process.exit(0)'], { cwd: process.cwd(), policy: { filesystem: 'read-only' } });
    assert.equal(result.error.code, 'FILESYSTEM_ISOLATION_UNAVAILABLE');
  });

  await t.test('preserves UTF-8 output', async () => {
    const sandbox = new ExecutionSandbox({ idFactory: () => 'sandbox-8c' });
    const result = await sandbox.execute(node, ['-e', 'process.stdout.write("தமிழ் 🚀")']);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout, 'தமிழ் 🚀');
  });

  await t.test('bounds retained records and prevents id reuse', async () => {
    let n = 0;
    const sandbox = new ExecutionSandbox({ maxRecords: 1, idFactory: () => `sandbox-${++n}` });
    await sandbox.execute(node, ['-e', 'process.exit(0)']);
    const second = await sandbox.execute(node, ['-e', 'process.exit(0)']);
    assert.equal(second.executionId, 'sandbox-2');
    assert.equal(sandbox.listExecutions().length, 1);
    const conflict = await sandbox.execute(node, ['-e', 'process.exit(0)'], { executionId: 'sandbox-2' });
    assert.equal(conflict.error.code, 'EXECUTION_CONFLICT');
  });
});


test('ExecutionSandbox preserves the original record when an execution id is reused', async () => {
  const sandbox = new ExecutionSandbox({ idFactory: () => 'stable-id' });
  const first = await sandbox.execute(node, ['-e', 'process.stdout.write("original")']);
  const conflict = await sandbox.execute(node, ['-e', 'process.stdout.write("replacement")'], { executionId: first.executionId });
  assert.equal(conflict.error.code, 'EXECUTION_CONFLICT');
  assert.equal(sandbox.getExecution(first.executionId).stdout, 'original');
});

test('ExecutionSandbox records spawn failures as terminal failed executions', async () => {
  const sandbox = new ExecutionSandbox({ idFactory: () => 'spawn-failure' });
  const result = await sandbox.execute('super-command-that-does-not-exist', []);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SPAWN_FAILED');
  assert.equal(result.command, 'super-command-that-does-not-exist');
});
