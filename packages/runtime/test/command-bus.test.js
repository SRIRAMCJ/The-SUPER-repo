import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ObservabilityEngine, RuntimeCommandBus, RuntimeControlPlane, RuntimeOperations } from '../src/index.js';

function setup() {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const controlPlane = new RuntimeControlPlane({ eventBus, observability, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const operations = new RuntimeOperations({ controlPlane, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const commands = new RuntimeCommandBus({ controlPlane, operations, clock: () => new Date('2026-09-17T10:00:00.000Z'), correlationId: () => 'corr-test' });
  return { controlPlane, commands };
}

test('command bus exposes an executable catalog derived from runtime operations', () => {
  const { controlPlane, commands } = setup();
  const catalog = commands.list();
  assert.equal(catalog.length, 9);
  assert.equal(catalog.find((item) => item.command === 'runtime.cancel').input.required[0], 'executionId');
  controlPlane.close();
});

test('command bus executes read commands with stable correlation and timing metadata', async () => {
  const { controlPlane, commands } = setup();
  const result = await commands.execute('runtime.health');
  assert.equal(result.ok, true);
  assert.equal(result.correlationId, 'corr-test');
  assert.equal(result.data.status, 'healthy');
  assert.equal(result.durationMs, 0);
  assert.equal(result.schemaVersion, '0.1.0');
  controlPlane.close();
});

test('command bus validates control inputs before dispatch', async () => {
  const { controlPlane, commands } = setup();
  const result = await commands.execute('runtime.cancel', { executionId: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'COMMAND_FAILED');
  assert.match(result.error.message, /executionId/);
  controlPlane.close();
});

test('command bus enforces authorization independently of the transport gateway', async () => {
  const { controlPlane } = setup();
  const operations = new RuntimeOperations({ controlPlane });
  const commands = new RuntimeCommandBus({ controlPlane, operations, authorize: () => false, correlationId: () => 'denied' });
  const result = await commands.execute('runtime.snapshot');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(result.correlationId, 'denied');
  controlPlane.close();
});

test('command bus returns structured errors for unknown commands and rejects array input', async () => {
  const { controlPlane, commands } = setup();
  const missing = await commands.execute('runtime.missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'COMMAND_NOT_FOUND');
  const invalid = await commands.execute('runtime.health', []);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  controlPlane.close();
});
