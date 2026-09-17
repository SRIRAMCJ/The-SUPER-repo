import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkGovernanceEngine, EventBus, ExecutionStateStore } from '../src/index.js';

function run({ suiteId = 'bench', passed = 9, failed = 1, suites = [{ suiteId: 'core', status: 'failed', passed: 9, failed: 1 }] } = {}) {
  const caseCount = passed + failed;
  return { schemaVersion: '0.1.0', type: 'benchmark-run', benchmarkSuiteId: suiteId, caseCount, passed, failed, passRate: caseCount === 0 ? 0 : passed / caseCount, status: failed === 0 ? 'succeeded' : 'failed', suites };
}

test('initializes a versioned baseline and emits lifecycle event', async () => {
  const events = new EventBus();
  const engine = new BenchmarkGovernanceEngine({ eventBus: events });
  const baseline = await engine.initialize(run({ passed: 8, failed: 2 }), { source: 'ci', commit: 'abc' });
  assert.equal(baseline.baselineVersion, 1);
  assert.equal(baseline.version, 0);
  assert.equal(baseline.history.length, 1);
  assert.equal(events.history({ type: 'benchmark.baseline.initialized' }).length, 1);
});

test('rejects promotion when regression gates fail without mutating baseline', async () => {
  const store = new ExecutionStateStore();
  const engine = new BenchmarkGovernanceEngine({ store });
  await engine.initialize(run({ passed: 9, failed: 1 }));
  const result = await engine.promote(run({ passed: 7, failed: 3 }), { minPassRate: 0.8 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.regression.status, 'failed');
  const baseline = await engine.getBaseline('bench');
  assert.equal(baseline.baselineVersion, 1);
  assert.equal(baseline.current.passed, 9);
});

test('promotes a passing candidate and preserves history', async () => {
  const engine = new BenchmarkGovernanceEngine();
  await engine.initialize(run({ passed: 8, failed: 2 }));
  const result = await engine.promote(run({ passed: 10, failed: 0 }), { minPassRate: 0.9 });
  assert.equal(result.status, 'promoted');
  assert.equal(result.previousVersion, 1);
  assert.equal(result.version, 2);
  assert.equal(result.storeVersion, 1);
  const baseline = await engine.getBaseline('bench');
  assert.equal(baseline.baselineVersion, 2);
  assert.equal(baseline.history.length, 2);
  assert.equal(baseline.current.passed, 10);
});

test('supports rollback as a new auditable baseline revision', async () => {
  const engine = new BenchmarkGovernanceEngine();
  await engine.initialize(run({ passed: 8, failed: 2 }));
  await engine.promote(run({ passed: 10, failed: 0 }));
  const result = await engine.rollback('bench', 1, 1);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.targetVersion, 1);
  assert.equal(result.version, 3);
  const baseline = await engine.getBaseline('bench');
  assert.equal(baseline.baselineVersion, 3);
  assert.equal(baseline.current.passed, 8);
  assert.equal(baseline.history.length, 3);
  assert.equal(baseline.history[2].action, 'rollback');
});

test('protects promotions with optimistic concurrency', async () => {
  const engine = new BenchmarkGovernanceEngine();
  await engine.initialize(run({ passed: 8, failed: 2 }));
  await engine.promote(run({ passed: 9, failed: 1 }), {}, 0);
  await assert.rejects(() => engine.promote(run({ passed: 10, failed: 0 }), {}, 0), (error) => error.code === 'EXECUTION_STATE_CONFLICT');
});

test('reports missing baseline and missing rollback version structurally', async () => {
  const engine = new BenchmarkGovernanceEngine();
  const evaluation = await engine.evaluate(run({ passed: 10, failed: 0 }));
  assert.equal(evaluation.error.code, 'BENCHMARK_BASELINE_NOT_FOUND');
  await engine.initialize(run({ passed: 8, failed: 2 }));
  const rollback = await engine.rollback('bench', 99);
  assert.equal(rollback.error.code, 'BENCHMARK_VERSION_NOT_FOUND');
});

test('rejects corrupt benchmark metrics before governance decisions', async () => {
  const engine = new BenchmarkGovernanceEngine();
  await assert.rejects(() => engine.initialize({ ...run(), passRate: 0.99 }), /passRate must match/);
  await engine.initialize(run());
  await assert.rejects(() => engine.promote({ ...run({ passed: 10, failed: 0 }), suites: [{ suiteId: 'core', passed: -1, failed: 1 }] }), /valid non-negative/);
});
