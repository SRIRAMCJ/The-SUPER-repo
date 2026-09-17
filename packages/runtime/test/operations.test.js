import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ObservabilityEngine, RuntimeControlPlane, RuntimeOperations } from '../src/index.js';

function createOperations(overrides = {}) {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const controlPlane = new RuntimeControlPlane({ eventBus, observability, ...overrides, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  return { eventBus, controlPlane, operations: new RuntimeOperations({ controlPlane, clock: () => new Date('2026-09-17T10:00:00.000Z') }) };
}

test('runtime operations exposes a stable operational catalog', () => {
  const { controlPlane, operations } = createOperations();
  const catalog = operations.getOperations();
  assert.equal(catalog.length, 9);
  assert.equal(catalog.find((item) => item.id === 'runtime.diagnostics').path, '/diagnostics');
  assert.equal(catalog.find((item) => item.id === 'runtime.cancel').classification, 'control');
  controlPlane.close();
});

test('runtime diagnostics reports required and optional runtime components', async () => {
  const { controlPlane, operations } = createOperations();
  const report = await operations.diagnostics();
  assert.equal(report.type, 'runtime-diagnostics');
  assert.equal(report.status, 'passed');
  assert.ok(report.summary.checks >= 5);
  assert.equal(report.runtime.platform, process.platform);
  assert.ok(report.checks.some((check) => check.id === 'component.observability' && check.status === 'pass'));
  assert.ok(report.checks.some((check) => check.id === 'component.state-store' && check.status === 'warning'));
  controlPlane.close();
});

test('runtime diagnostics detects unavailable required observability without leaking event payloads', async () => {
  const operations = new RuntimeOperations({
    controlPlane: {
      getHealth: () => ({ status: 'healthy', activeExecutions: 0, recentFailures: 0 }),
      snapshot: async () => ({}),
      observability: { getMetrics: () => ({ activeExecutions: 0 }) }
    }
  });
  const report = await operations.diagnostics();
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find((check) => check.id === 'component.observability').status, 'fail');
  assert.equal(JSON.stringify(report).includes('payload'), false);
});

test('runtime diagnostics is structurally isolated from caller mutation', async () => {
  const { controlPlane, operations } = createOperations();
  const report = await operations.diagnostics();
  report.checks[0].details.activeExecutions = 999;
  const next = await operations.diagnostics();
  assert.notEqual(next.checks[0].details.activeExecutions, 999);
  controlPlane.close();
});
