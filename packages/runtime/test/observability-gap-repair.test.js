import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityGapRepairCoordinator } from '../src/index.js';

function setup(sourceRepair) {
  const imported = [];
  const transport = {
    ingest(events) {
      imported.push(...events);
      return events.map((event) => ({ state: 'published', event }));
    },
    snapshot() { return { nodeId: 'repair-node' }; },
  };
  const checkpoint = {
    current: { sourceNodeId: 'source-a', sourceSequence: 2, eventSequence: 22, fencingToken: 5 },
    get() { return this.current; },
    commit(value) { this.current = { ...value }; return { state: 'committed', checkpoint: this.current }; },
  };
  return { imported, checkpoint, coordinator: new ObservabilityGapRepairCoordinator({ source: { repair: sourceRepair }, transport, checkpoint, idFactory: (() => { let n = 0; return () => 'repair-' + (++n); })() }) };
}

test('gap repair validates the complete contiguous range before ingest and advances checkpoint', async () => {
  const { imported, checkpoint, coordinator } = setup(async ({ sourceNodeId, fromSourceSequence, toSourceSequence }) =>
    Array.from({ length: toSourceSequence - fromSourceSequence + 1 }, (_, i) => ({
      id: 'e' + (fromSourceSequence + i),
      type: 'execution.completed',
      sourceNodeId,
      sourceSequence: fromSourceSequence + i,
      sequence: 30 + i,
      fencingToken: 5,
    })));
  const result = await coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 3, toSourceSequence: 4, fencingToken: 5 });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.repaired, 2);
  assert.equal(imported.length, 2);
  assert.equal(checkpoint.sourceSequence, 4);
});

test('gap repair rejects incomplete or non-contiguous source responses without ingesting', async () => {
  let calls = 0;
  const { imported, coordinator } = setup(async ({ sourceNodeId }) => {
    calls += 1;
    return [{ id: 'bad', sourceNodeId, sourceSequence: 4, sequence: 40, fencingToken: 5 }];
  });
  const result = await coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 3, toSourceSequence: 4, fencingToken: 5 });
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'REPAIR_INCOMPLETE_RANGE');
  assert.equal(imported.length, 0);
  assert.equal(calls, 1);
});

test('gap repair blocks stale fencing and supports bounded retry with force', async () => {
  let calls = 0;
  const { coordinator } = setup(async () => { calls += 1; return []; });
  const stale = await coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 3, toSourceSequence: 3, fencingToken: 4 });
  assert.equal(stale.state, 'blocked');
  assert.equal(stale.error.code, 'CHECKPOINT_STALE_FENCE');

  const limited = new ObservabilityGapRepairCoordinator({
    source: { repair: async () => { calls += 1; return []; } },
    transport: { ingest: () => [], snapshot: () => ({ nodeId: 'repair-node' }) },
    maxAttempts: 1,
    idFactory: (() => { let n = 0; return () => 'limited-' + (++n); })(),
  });
  const first = await limited.repair({ sourceNodeId: 'source-a', fromSourceSequence: 1, toSourceSequence: 1 });
  const second = await limited.repair({ sourceNodeId: 'source-a', fromSourceSequence: 1, toSourceSequence: 1 });
  assert.equal(first.state, 'failed');
  assert.equal(second.state, 'blocked');
  const forced = await limited.repair({ sourceNodeId: 'source-a', fromSourceSequence: 1, toSourceSequence: 1, force: true });
  assert.equal(forced.state, 'failed');
});

test('gap repair deduplicates concurrent identical repairs and honors cancellation', async () => {
  let resolve;
  const { coordinator } = setup(() => new Promise((r) => { resolve = r; }));
  const first = coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 3, toSourceSequence: 3 });
  const second = coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 3, toSourceSequence: 3 });
  const resultsPromise = Promise.all([first, second]);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 5, toSourceSequence: 5, signal: controller.signal });
  assert.equal(cancelled.state, 'cancelled');
  resolve([]);
  const [firstResult, secondResult] = await resultsPromise;
  assert.equal(firstResult.state, 'failed');
  assert.equal(secondResult.state, 'failed');
});

test('gap repair keeps bounded immutable audit history', async () => {
  const { coordinator } = setup(async () => []);
  const result = await coordinator.repair({ sourceNodeId: 'source-a', fromSourceSequence: 3, toSourceSequence: 3 });
  assert.equal(result.state, 'failed');
  const limited = new ObservabilityGapRepairCoordinator({
    source: { repair: async () => [] },
    transport: { ingest: () => [], snapshot: () => ({ nodeId: 'repair-node' }) },
    maxHistory: 1,
  });
  await limited.repair({ sourceNodeId: 'source-a', fromSourceSequence: 1, toSourceSequence: 1 });
  const history = limited.history();
  assert.equal(history.length, 1);
  assert.throws(() => history.push({}), TypeError);
});
