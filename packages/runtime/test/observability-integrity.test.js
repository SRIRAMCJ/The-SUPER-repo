import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityIntegrityKernel, ObservabilityCheckpointAuthority } from '../src/index.js';

const events = [
  { id:'e1', type:'execution.started', sourceNodeId:'source-a', sourceSequence:1, sequence:11, fencingToken:4, executionId:'x', status:'running', timestamp:'2026-09-18T00:00:00.000Z' },
  { id:'e2', type:'execution.completed', sourceNodeId:'source-a', sourceSequence:2, sequence:12, fencingToken:4, executionId:'x', status:'succeeded', timestamp:'2026-09-18T00:00:01.000Z' },
];

test('integrity digest is deterministic and range verification is strict', () => {
  const digest = ObservabilityIntegrityKernel.digestEvents(events);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(ObservabilityIntegrityKernel.digestEvents(structuredClone(events)), digest);
  assert.equal(ObservabilityIntegrityKernel.verifyRange(events, { sourceNodeId:'source-a', fromSourceSequence:1, toSourceSequence:2, expectedDigest:digest }).valid, true);
  assert.equal(ObservabilityIntegrityKernel.verifyRange([events[1]], { sourceNodeId:'source-a', fromSourceSequence:1, toSourceSequence:2 }).code, 'INTEGRITY_RANGE_INCOMPLETE');
  assert.equal(ObservabilityIntegrityKernel.verifyRange(events, { sourceNodeId:'source-a', fromSourceSequence:1, toSourceSequence:2, expectedDigest:'0'.repeat(64) }).code, 'INTEGRITY_DIGEST_MISMATCH');
});

test('checkpoint compare-and-set rejects stale concurrent writers', () => {
  const authority = new ObservabilityCheckpointAuthority({ idFactory:(()=>{let i=0;return()=>String(++i)})() });
  const first = authority.commit({ nodeId:'n1', sourceNodeId:'source-a', sourceSequence:1, eventSequence:11, fencingToken:1, expectedVersion:0 });
  assert.equal(first.state, 'committed');
  assert.equal(first.checkpoint.version, 1);
  const stale = authority.commit({ nodeId:'n2', sourceNodeId:'source-a', sourceSequence:2, eventSequence:12, fencingToken:1, expectedVersion:0 });
  assert.equal(stale.state, 'version_conflict');
  const next = authority.commit({ nodeId:'n2', sourceNodeId:'source-a', sourceSequence:2, eventSequence:12, fencingToken:1, expectedVersion:1 });
  assert.equal(next.state, 'committed');
  assert.equal(authority.get('source-a').version, 2);
});
