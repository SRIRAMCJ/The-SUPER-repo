import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ObservabilityEngine, RuntimeControlPlane } from '../src/index.js';

test('control plane derives health and execution history from observability', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const controlPlane = new RuntimeControlPlane({ eventBus, observability, clock: () => new Date('2026-09-17T10:00:00.000Z') });

  eventBus.emit({ id: 's1', type: 'execution.started', executionId: 'e1', capabilityId: 'repo.scan', timestamp: '2026-09-17T09:59:59.000Z' });
  eventBus.emit({ id: 'p1', type: 'execution.progress', executionId: 'e1', capabilityId: 'repo.scan', timestamp: '2026-09-17T09:59:59.500Z' });
  eventBus.emit({ id: 'c1', type: 'execution.completed', executionId: 'e1', capabilityId: 'repo.scan', timestamp: '2026-09-17T10:00:00.000Z' });

  assert.equal(controlPlane.getHealth().status, 'healthy');
  assert.equal(controlPlane.getExecutions()[0].executionId, 'e1');
  assert.equal(controlPlane.getExecutions()[0].status, 'completed');
  controlPlane.close();
});

test('control plane identifies degraded and critical runtime health from recent failures', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus, clock: () => new Date('2026-09-17T10:00:00.000Z') });
  const controlPlane = new RuntimeControlPlane({ eventBus, observability, clock: () => new Date('2026-09-17T10:00:00.000Z') });

  eventBus.emit({ type: 'execution.started', executionId: 'e2', timestamp: '2026-09-17T09:59:59.000Z' });
  eventBus.emit({ type: 'execution.failed', executionId: 'e2', timestamp: '2026-09-17T09:59:59.100Z' });
  assert.equal(controlPlane.getHealth().status, 'degraded');

  for (let i = 0; i < 5; i += 1) eventBus.emit({ type: 'execution.failed', executionId: `f${i}`, timestamp: '2026-09-17T09:59:59.200Z' });
  assert.equal(controlPlane.getHealth().status, 'critical');
});

test('control plane exposes evolution state through the existing state boundary', async () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus });
  const stateStore = { list: async () => [{ executionId: 'evolution-control:ec1', type: 'evolution-control', status: 'running', controlId: 'ec1' }] };
  const controlPlane = new RuntimeControlPlane({ eventBus, observability, stateStore });

  const view = await controlPlane.getEvolution();
  assert.equal(view.active, 1);
  assert.equal(view.controls[0].controlId, 'ec1');
});

test('control plane snapshot unifies health, metrics, executions, evolution, traces and events', async () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus });
  const controlPlane = new RuntimeControlPlane({ eventBus, observability, stateStore: { list: async () => [] } });
  eventBus.emit({ type: 'execution.started', executionId: 'e3', timestamp: '2026-09-17T09:59:59.000Z' });
  eventBus.emit({ type: 'execution.completed', executionId: 'e3', timestamp: '2026-09-17T10:00:00.000Z' });

  const snapshot = await controlPlane.snapshot();
  assert.equal(snapshot.type, 'runtime-control-plane-snapshot');
  assert.equal(snapshot.health.status, 'healthy');
  assert.equal(snapshot.executions.length, 1);
  assert.ok(snapshot.metrics);
  assert.ok(Array.isArray(snapshot.traces));
  assert.ok(Array.isArray(snapshot.recentEvents));
});
