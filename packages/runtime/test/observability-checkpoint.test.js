import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityCheckpointAuthority } from '../src/index.js';

test('checkpoint authority commits monotonically and rejects stale fences', () => {
  let id = 0;
  const authority = new ObservabilityCheckpointAuthority({ idFactory: () => 'id-' + (++id) });
  assert.equal(authority.commit({ nodeId:'n1', sourceNodeId:'source-a', sourceSequence:1, eventSequence:10, fencingToken:2 }).state, 'committed');
  assert.equal(authority.commit({ nodeId:'n2', sourceNodeId:'source-a', sourceSequence:2, eventSequence:11, fencingToken:1 }).state, 'stale_fence');
  assert.equal(authority.commit({ nodeId:'n2', sourceNodeId:'source-a', sourceSequence:1, eventSequence:9, fencingToken:2 }).state, 'stale');
  assert.equal(authority.commit({ nodeId:'n2', sourceNodeId:'source-a', sourceSequence:1, eventSequence:10, fencingToken:2 }).state, 'duplicate');
  assert.equal(authority.get('source-a').sourceSequence, 1);
});

test('checkpoint authority detects same-cursor conflicts and validates checkpoints', () => {
  const authority = new ObservabilityCheckpointAuthority({ idFactory: () => 'id' });
  authority.commit({ nodeId:'n1', sourceNodeId:'source-a', sourceSequence:4, eventSequence:40, fencingToken:3, digest:'abc' });
  assert.equal(authority.commit({ nodeId:'n1', sourceNodeId:'source-a', sourceSequence:4, eventSequence:39, fencingToken:3 }).state, 'conflict');
  assert.equal(authority.validate({ sourceNodeId:'source-a', sourceSequence:4, fencingToken:3, eventSequence:40 }).valid, true);
  assert.equal(authority.validate({ sourceNodeId:'source-a', sourceSequence:3, fencingToken:3 }).code, 'CHECKPOINT_STALE_SOURCE');
  assert.equal(authority.validate({ sourceNodeId:'source-a', sourceSequence:4, fencingToken:2 }).code, 'CHECKPOINT_STALE_FENCE');
  assert.equal(authority.validate({ sourceNodeId:'missing', sourceSequence:1, fencingToken:1 }).code, 'CHECKPOINT_MISSING');
});

test('checkpoint snapshots and history are immutable and bounded', () => {
  let now = 0; let id = 0;
  const authority = new ObservabilityCheckpointAuthority({ maxHistory:2, clock:()=>new Date(++now), idFactory:()=>String(++id) });
  authority.commit({ nodeId:'n', sourceNodeId:'a', sourceSequence:1, eventSequence:1, fencingToken:1 });
  authority.commit({ nodeId:'n', sourceNodeId:'a', sourceSequence:2, eventSequence:2, fencingToken:1 });
  authority.commit({ nodeId:'n', sourceNodeId:'a', sourceSequence:3, eventSequence:3, fencingToken:1 });
  const snapshot=authority.snapshot();
  assert.equal(snapshot.history.length,2);
  assert.throws(()=>{ snapshot.checkpoints.a.sourceSequence=99; }, TypeError);
  assert.throws(()=>{ authority.history().push({}); }, TypeError);
});
