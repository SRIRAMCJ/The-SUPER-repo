import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ObservabilityEngine, RuntimeEventTransport, FileEventJournal } from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('observability subscribes to the event bus and tracks execution lifecycle metrics', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus, clock: () => new Date('2026-01-01T00:00:00.000Z') });

  eventBus.emit({ id: 'start-1', type: 'execution.started', executionId: 'exec-1', capabilityId: 'repo.scan', timestamp: '2026-01-01T00:00:00.000Z', status: 'started', data: { secret: 'not-retained' } });
  eventBus.emit({ id: 'progress-1', type: 'execution.progress', executionId: 'exec-1', capabilityId: 'repo.scan', timestamp: '2026-01-01T00:00:00.500Z', status: 'progress', data: { secret: 'not-retained' } });
  eventBus.emit({ id: 'complete-1', type: 'execution.completed', executionId: 'exec-1', capabilityId: 'repo.scan', timestamp: '2026-01-01T00:00:01.250Z', status: 'completed', data: { output: 'not-retained' } });

  const metrics = observability.getMetrics();
  const values = new Map(metrics.metrics.map((metric) => [metric.name, metric.value]));
  assert.equal(values.get('executions.started'), 1);
  assert.equal(values.get('executions.progress_events'), 1);
  assert.equal(values.get('executions.completed'), 1);
  assert.equal(metrics.activeExecutions, 0);

  const events = observability.getEvents({ executionId: 'exec-1' });
  assert.equal(events.length, 3);
  assert.equal('data' in events[0], false);
});

test('observability creates correlated spans and duration metrics', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus });

  eventBus.emit({ id: 'start-2', type: 'workflow.started', executionId: 'wf-1', timestamp: '2026-01-01T00:00:00.000Z', status: 'started' });
  eventBus.emit({ id: 'done-2', type: 'workflow.completed', executionId: 'wf-1', timestamp: '2026-01-01T00:00:02.500Z', status: 'completed' });

  const traces = observability.getTraces({ executionId: 'wf-1' });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].name, 'workflow');
  assert.equal(traces[0].durationMs, 2500);
  assert.equal(traces[0].status, 'completed');

  const values = new Map(observability.getMetrics().metrics.map((metric) => [metric.name, metric.value]));
  assert.equal(values.get('duration.count.workflow'), 1);
  assert.equal(values.get('duration.total_ms.workflow'), 2500);
  assert.equal(values.get('duration.max_ms.workflow'), 2500);
  assert.equal(values.get('duration.min_ms.workflow'), 2500);
});

test('observability handles failed and denied executions without retaining payload data', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus });

  eventBus.emit({ id: 'deny-1', type: 'execution.denied', executionId: 'exec-3', capabilityId: 'dangerous.action', status: 'denied', error: { code: 'POLICY_DENIED' } });
  eventBus.emit({ id: 'fail-1', type: 'execution.failed', executionId: 'exec-3', capabilityId: 'dangerous.action', status: 'failed', error: { code: 'POLICY_DENIED' } });

  const values = new Map(observability.getMetrics().metrics.map((metric) => [metric.name, metric.value]));
  assert.equal(values.get('executions.denied'), 1);
  assert.equal(values.get('executions.failed'), 1);
  assert.equal(observability.getTraces({ executionId: 'exec-3' }).length, 0);
});

test('observability bounds retained events and traces', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus, maxEvents: 2, maxTraces: 1 });

  eventBus.emit({ id: 's1', type: 'task.started', executionId: 'task-1', timestamp: '2026-01-01T00:00:00.000Z' });
  eventBus.emit({ id: 's2', type: 'task.started', executionId: 'task-2', timestamp: '2026-01-01T00:00:01.000Z' });
  eventBus.emit({ id: 's3', type: 'task.started', executionId: 'task-3', timestamp: '2026-01-01T00:00:02.000Z' });

  assert.equal(observability.getEvents().length, 2);
  assert.equal(observability.getTraces().length, 1);
  assert.equal(observability.getTraces()[0].executionId, 'task-3');
});

test('observability validates events and supports unsubscribe', () => {
  const eventBus = new EventBus();
  const observability = new ObservabilityEngine({ eventBus });

  assert.throws(() => observability.observe(null), /event must be an object/);
  assert.throws(() => observability.getEvents(null), /filter must be an object/);
  observability.close();
  eventBus.emit({ type: 'execution.started', executionId: 'exec-4' });
  assert.equal(observability.getEvents().length, 0);
});

test('observability consumes the asynchronous transport and releases subscription', async () => {
  const eventTransport = new RuntimeEventTransport();
  const observability = new ObservabilityEngine({ eventTransport });
  await eventTransport.publish({ type: 'execution.started', executionId: 'one' });
  assert.equal(observability.getEvents().length, 1);
  observability.close();
  await eventTransport.publish({ type: 'execution.completed', executionId: 'one' });
  assert.equal(observability.getEvents().length, 1);
  await eventTransport.close();
});

test('observability bounds metric series and active execution cardinality', () => {
  const observability = new ObservabilityEngine({ maxMetricSeries: 8, maxActiveExecutions: 2 });
  for (let i = 0; i < 20; i++) observability.observe({ type: `custom.${i}` });
  for (let i = 0; i < 3; i++) observability.observe({ type: 'execution.started', executionId: `exec-${i}` });
  const snapshot = observability.getMetrics();
  const metrics = new Map(snapshot.metrics.map((item) => [item.name, item.value]));
  assert.equal(snapshot.metrics.length, 8);
  assert.ok(metrics.get('metrics.dropped_series') > 0);
  assert.equal(metrics.get('active_executions.evicted'), 1);
  assert.equal(snapshot.activeExecutions, 2);
});

test('observability rebuilds from journal and incrementally syncs without duplicate metrics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-observability-journal-'));
  try {
    const journal = new FileEventJournal(directory);
    const first = await journal.append({ type: 'execution.started', executionId: 'e1', timestamp: '2026-01-01T00:00:00.000Z' });
    await journal.append({ type: 'execution.completed', executionId: 'e1', timestamp: '2026-01-01T00:00:01.000Z' });
    const restored = new ObservabilityEngine();
    assert.deepEqual(await restored.syncFromJournal(journal), { applied: 2, sequence: 2, head: 2 });
    assert.equal((await restored.syncFromJournal(journal)).applied, 0);
    assert.equal(restored.getTraces()[0].durationMs, 1000);
    await journal.append({ type: 'execution.failed', executionId: 'e2' });
    assert.equal((await restored.syncFromJournal(journal)).applied, 1);
    const metrics = new Map(restored.getMetrics().metrics.map((item) => [item.name, item.value]));
    assert.equal(metrics.get('executions.started'), 1);
    assert.equal(metrics.get('executions.completed'), 1);
    assert.equal(metrics.get('executions.failed'), 1);
    assert.equal((await new ObservabilityEngine().syncFromJournal(journal)).applied, 3);
    await journal.compactThrough(1, first.hash);
    await assert.rejects(new ObservabilityEngine().syncFromJournal(journal), { code: 'EVENT_JOURNAL_GAP' });
    assert.equal((await restored.syncFromJournal(journal)).applied, 0);
    const live = new ObservabilityEngine({ eventTransport: new RuntimeEventTransport() });
    await assert.rejects(live.syncFromJournal(journal), /without a live event source/);
    live.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
