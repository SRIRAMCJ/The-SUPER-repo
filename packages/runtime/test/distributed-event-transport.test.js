import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributedEventTransport } from '../src/index.js';

test('distributed event transport assigns local order while preserving per-source sequence', () => {
  const transport = new DistributedEventTransport({ nodeId: 'node-a' });
  const remote = transport.ingest([
    { id: 'remote-1', type: 'execution.started', sourceNodeId: 'node-b', sourceSequence: 7, executionId: 'exec-1' },
  ]);
  assert.equal(remote[0].state, 'published');
  assert.equal(remote[0].event.sequence, 1);
  assert.equal(remote[0].event.sourceSequence, 7);
  const local = transport.publish({ id: 'local-1', type: 'execution.completed', executionId: 'exec-1' });
  assert.equal(local.event.sequence, 2);
  assert.equal(local.event.sourceSequence, 1);
});

test('distributed event transport rejects stale source sequence and duplicate event IDs', () => {
  const transport = new DistributedEventTransport({ nodeId: 'node-a' });
  assert.equal(transport.publish({ id: 'e1', type: 'execution.started' }).state, 'published');
  assert.equal(transport.publish({ id: 'e2', type: 'execution.progress' }).state, 'published');
  assert.equal(transport.ingest([{ id: 'r1', type: 'execution.started', sourceNodeId: 'node-b', sourceSequence: 2 }])[0].state, 'published');
  assert.equal(transport.ingest([{ id: 'r2', type: 'execution.progress', sourceNodeId: 'node-b', sourceSequence: 1 }])[0].state, 'stale');
  assert.equal(transport.publish({ id: 'e2', type: 'execution.progress' }).state, 'duplicate');
});

test('distributed event transport bounds history and seen IDs and exposes immutable snapshots', () => {
  const transport = new DistributedEventTransport({ nodeId: 'node-a', maxEvents: 2, maxSeen: 2 });
  transport.publish({ id: 'e1', type: 'a' });
  transport.publish({ id: 'e2', type: 'b' });
  transport.publish({ id: 'e3', type: 'c' });
  assert.equal(transport.history().length, 2);
  const snapshot = transport.snapshot();
  assert.equal(snapshot.retainedEvents, 2);
  assert.throws(() => { snapshot.sourceSequences['node-a'] = 99; }, TypeError);
});
