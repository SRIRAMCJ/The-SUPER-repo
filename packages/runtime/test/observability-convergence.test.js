import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityConvergenceKernel } from '../src/index.js';

function harness({ remoteCheckpoint, repairState = 'succeeded' } = {}) {
  let repairs = 0;
  const local = {
    snapshot() {
      return { checkpoint: { checkpoints: { 'source-a': { sourceNodeId: 'source-a', sourceSequence: 2, eventSequence: 20, fencingToken: 4 } } } };
    },
  };
  const remote = {
    async inspect() { return { sourceNodeId: 'source-a', checkpoint: remoteCheckpoint }; },
    async repair(args) { repairs += 1; return { state: repairState, ...args }; },
  };
  return { get repairs() { return repairs; }, local, remote };
}

test('convergence reports already converged without repair', async () => {
  const h = harness({ remoteCheckpoint: { sourceNodeId: 'source-a', sourceSequence: 2, eventSequence: 20, fencingToken: 4 } });
  const kernel = new ObservabilityConvergenceKernel({ local: h.local, remote: h.remote, idFactory: () => 'c1' });
  const result = await kernel.reconcile({ sourceNodeId: 'source-a' });
  assert.equal(result.state, 'converged');
  assert.equal(result.comparison.sourceSequence, 2);
});

test('convergence repairs sequence divergence and verifies the post-repair state', async () => {
  const h = harness({ remoteCheckpoint: { sourceNodeId: 'source-a', sourceSequence: 4, eventSequence: 40, fencingToken: 4 } });
  let inspected = 0;
  h.remote.inspect = async () => {
    inspected += 1;
    return inspected === 1
      ? { sourceNodeId: 'source-a', checkpoint: { sourceSequence: 4, eventSequence: 40, fencingToken: 4 } }
      : { sourceNodeId: 'source-a', checkpoint: { sourceSequence: 2, eventSequence: 20, fencingToken: 4 } };
  };
  const kernel = new ObservabilityConvergenceKernel({ local: h.local, remote: h.remote, idFactory: () => 'c2' });
  const result = await kernel.reconcile({ sourceNodeId: 'source-a' });
  assert.equal(result.state, 'divergent');
  assert.equal(result.comparison.fromSourceSequence, 3);
  assert.equal(h.repairs, 1);
});

test('convergence blocks fencing divergence unless forced', async () => {
  const h = harness({ remoteCheckpoint: { sourceNodeId: 'source-a', sourceSequence: 4, eventSequence: 40, fencingToken: 5 } });
  const kernel = new ObservabilityConvergenceKernel({ local: h.local, remote: h.remote, idFactory: (() => { let n = 0; return () => 'c' + (++n); })() });
  const blocked = await kernel.reconcile({ sourceNodeId: 'source-a' });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.comparison.reason, 'FENCING_DIVERGENCE');
});

test('convergence deduplicates concurrent reconciliation and honors cancellation', async () => {
  let release;
  const local = { snapshot: () => ({ checkpoint: { checkpoints: { 'source-a': { sourceSequence: 2, eventSequence: 20, fencingToken: 4 } } } }) };
  const remote = {
    inspect: () => new Promise((resolve) => { release = resolve; }),
    repair: async () => ({ state: 'succeeded' }),
  };
  const kernel = new ObservabilityConvergenceKernel({ local, remote, idFactory: () => 'c3' });
  const first = kernel.reconcile({ sourceNodeId: 'source-a' });
  const second = kernel.reconcile({ sourceNodeId: 'source-a' });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await kernel.reconcile({ sourceNodeId: 'source-b', signal: controller.signal });
  assert.equal(cancelled.state, 'cancelled');
  release({ sourceNodeId: 'source-a', checkpoint: { sourceSequence: 2, eventSequence: 20, fencingToken: 4 } });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.state, 'converged');
  assert.equal(b.state, 'converged');
});

test('convergence history is bounded and immutable', async () => {
  const h = harness({ sourceNodeId: 'source-a', sourceSequence: 2, eventSequence: 20, fencingToken: 4 });
  const kernel = new ObservabilityConvergenceKernel({ local: h.local, remote: h.remote, maxHistory: 1, idFactory: () => 'c4' });
  await kernel.reconcile({ sourceNodeId: 'source-a' });
  const history = kernel.history();
  assert.equal(history.length, 1);
  assert.throws(() => history.push({}), TypeError);
});


test('convergence detects equal sequence with divergent checkpoint digests', async () => {
  const local = { snapshot: () => ({ checkpoint: { checkpoints: { 'source-a': { sourceSequence: 4, eventSequence: 40, fencingToken: 4, digest: 'a'.repeat(64) } } } }) };
  const remote = {
    async inspect() { return { sourceNodeId: 'source-a', checkpoint: { sourceSequence: 4, eventSequence: 40, fencingToken: 4, digest: 'b'.repeat(64) } }; },
    async repair() { throw new Error('repair must not run for digest-only divergence'); },
  };
  const kernel = new ObservabilityConvergenceKernel({ local, remote, idFactory: () => 'digest-divergence' });
  const result = await kernel.reconcile({ sourceNodeId: 'source-a' });
  assert.equal(result.state, 'divergent');
  assert.equal(result.comparison.reason, 'DIGEST_DIVERGENCE');
});

test('convergence accepts matching sequence and digest state', async () => {
  const digest = 'c'.repeat(64);
  const local = { snapshot: () => ({ checkpoint: { checkpoints: { 'source-a': { sourceSequence: 4, eventSequence: 40, fencingToken: 4, digest } } } }) };
  const remote = {
    async inspect() { return { sourceNodeId: 'source-a', checkpoint: { sourceSequence: 4, eventSequence: 40, fencingToken: 4, digest } }; },
  };
  const kernel = new ObservabilityConvergenceKernel({ local, remote, idFactory: () => 'digest-match' });
  const result = await kernel.reconcile({ sourceNodeId: 'source-a' });
  assert.equal(result.state, 'converged');
  assert.equal(result.comparison.digest, digest);
});
