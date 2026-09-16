import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ExecutionAudit } from '../src/index.js';

test('audits task-graph lifecycle and nested task events', () => {
  const events = new EventBus();
  const audit = new ExecutionAudit({ events, clock: () => new Date('2026-01-01T00:00:00Z') });
  events.emit({ type: 'task-graph.started', executionId: 'graph-1', timestamp: '2026-01-01T00:00:01Z' });
  events.emit({ type: 'task.started', executionId: 'graph-1', taskId: 'a', timestamp: '2026-01-01T00:00:02Z' });
  events.emit({ type: 'task.completed', executionId: 'graph-1', taskId: 'a', timestamp: '2026-01-01T00:00:03Z' });
  events.emit({ type: 'task-graph.completed', executionId: 'graph-1', timestamp: '2026-01-01T00:00:04Z' });

  const record = audit.get('graph-1');
  assert.equal(record.kind, 'task-graph');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.startedAt, '2026-01-01T00:00:01Z');
  assert.equal(record.finishedAt, '2026-01-01T00:00:04Z');
  assert.equal(record.events.length, 4);
});

test('audits mission lifecycle by missionExecutionId', () => {
  const events = new EventBus();
  const audit = new ExecutionAudit({ events });
  events.emit({ type: 'mission.started', missionExecutionId: 'mission-1' });
  events.emit({ type: 'mission.failed', missionExecutionId: 'mission-1', error: { code: 'CHILD_FAILED' } });

  const record = audit.get('mission-1');
  assert.equal(record.kind, 'mission');
  assert.equal(record.status, 'failed');
  assert.equal(record.error.code, 'CHILD_FAILED');
});

test('records task-graph cancellation as terminal cancelled state', () => {
  const events = new EventBus();
  const audit = new ExecutionAudit({ events });
  events.emit({ type: 'task-graph.started', executionId: 'graph-2' });
  events.emit({ type: 'task-graph.cancelled', executionId: 'graph-2', error: { code: 'EXECUTION_CANCELLED' } });
  assert.equal(audit.get('graph-2').status, 'cancelled');
});
