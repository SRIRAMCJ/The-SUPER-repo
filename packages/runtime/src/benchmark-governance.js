import { createExecutionId } from './events.js';
import { BenchmarkRegressionEngine } from './benchmark-regression.js';
import { ExecutionStateStore } from './state.js';

export class BenchmarkGovernanceEngine {
  constructor({ regressionEngine = new BenchmarkRegressionEngine(), store = new ExecutionStateStore(), eventBus = null, clock = () => new Date() } = {}) {
    if (!regressionEngine || typeof regressionEngine.compare !== 'function') throw new TypeError('BenchmarkGovernanceEngine requires regressionEngine');
    if (!store || typeof store.create !== 'function' || typeof store.get !== 'function' || typeof store.update !== 'function') throw new TypeError('BenchmarkGovernanceEngine requires a compatible state store');
    this.regressionEngine = regressionEngine;
    this.store = store;
    this.eventBus = eventBus;
    this.clock = clock;
  }

  async getBaseline(benchmarkSuiteId) {
    validateSuiteId(benchmarkSuiteId);
    const state = await this.store.get(stateId(benchmarkSuiteId));
    return state ? clone(state) : null;
  }

  async initialize(baselineRun, metadata = {}) {
    validateRun(baselineRun, 'baseline');
    const id = stateId(baselineRun.benchmarkSuiteId);
    if (await this.store.get(id)) throw conflict(`Benchmark baseline already exists: ${baselineRun.benchmarkSuiteId}`, 'BENCHMARK_BASELINE_EXISTS');
    const now = this.clock().toISOString();
    const state = await this.store.create({
      executionId: id,
      type: 'benchmark-baseline',
      schemaVersion: '0.1.0',
      benchmarkSuiteId: baselineRun.benchmarkSuiteId,
      baselineVersion: 1,
      current: clone(baselineRun),
      history: [{ version: 1, action: 'initialized', benchmarkRun: clone(baselineRun), at: now }],
      metadata: sanitizeMetadata(metadata),
      createdAt: now,
      updatedAt: now
    });
    await this.#emit('benchmark.baseline.initialized', state);
    return clone(state);
  }

  async evaluate(candidateRun, gates = {}) {
    validateRun(candidateRun, 'candidate');
    const baseline = await this.getBaseline(candidateRun.benchmarkSuiteId);
    if (!baseline) return failure('BENCHMARK_BASELINE_NOT_FOUND', `No benchmark baseline exists for ${candidateRun.benchmarkSuiteId}`);
    const regression = this.regressionEngine.compare(baseline.current, candidateRun, gates);
    return Object.freeze({ schemaVersion: '0.1.0', type: 'benchmark-governance-evaluation', benchmarkSuiteId: candidateRun.benchmarkSuiteId, baselineVersion: baseline.baselineVersion, eligibleForPromotion: regression.status === 'passed', regression });
  }

  async promote(candidateRun, gates = {}, expectedVersion = null, metadata = {}) {
    validateRun(candidateRun, 'candidate');
    const baselineId = stateId(candidateRun.benchmarkSuiteId);
    const current = await this.store.get(baselineId);
    if (!current) return failure('BENCHMARK_BASELINE_NOT_FOUND', `No benchmark baseline exists for ${candidateRun.benchmarkSuiteId}`);
    validateExpectedStoreVersion(expectedVersion);
    const regression = this.regressionEngine.compare(current.current, candidateRun, gates);
    if (regression.status !== 'passed') {
      await this.#emit('benchmark.baseline.promotion_rejected', { benchmarkSuiteId: candidateRun.benchmarkSuiteId, baselineVersion: current.baselineVersion, regression });
      return Object.freeze({ schemaVersion: '0.1.0', type: 'benchmark-promotion', status: 'rejected', benchmarkSuiteId: candidateRun.benchmarkSuiteId, baselineVersion: current.baselineVersion, regression, violations: regression.violations ?? [] });
    }

    const now = this.clock().toISOString();
    const nextBaselineVersion = current.baselineVersion + 1;
    const nextHistory = [...current.history, { version: nextBaselineVersion, action: 'promoted', benchmarkRun: clone(candidateRun), regression: clone(regression), metadata: sanitizeMetadata(metadata), at: now }];
    const updated = await this.store.update(baselineId, { baselineVersion: nextBaselineVersion, current: clone(candidateRun), history: nextHistory, updatedAt: now }, expectedVersion);
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'benchmark-promotion', status: 'promoted', promotionId: createExecutionId(), benchmarkSuiteId: candidateRun.benchmarkSuiteId, previousVersion: current.baselineVersion, version: updated.baselineVersion, storeVersion: updated.version, regression });
    await this.#emit('benchmark.baseline.promoted', result);
    return result;
  }

  async rollback(benchmarkSuiteId, targetVersion, expectedVersion = null) {
    validateSuiteId(benchmarkSuiteId);
    if (!Number.isInteger(targetVersion) || targetVersion < 1) throw new TypeError('targetVersion must be a positive integer');
    validateExpectedStoreVersion(expectedVersion);
    const id = stateId(benchmarkSuiteId);
    const current = await this.store.get(id);
    if (!current) return failure('BENCHMARK_BASELINE_NOT_FOUND', `No benchmark baseline exists for ${benchmarkSuiteId}`);
    const target = current.history.find((entry) => entry.version === targetVersion);
    if (!target) return failure('BENCHMARK_VERSION_NOT_FOUND', `Benchmark baseline version ${targetVersion} does not exist`);
    const now = this.clock().toISOString();
    const nextBaselineVersion = current.baselineVersion + 1;
    const updated = await this.store.update(id, { baselineVersion: nextBaselineVersion, current: clone(target.benchmarkRun), history: [...current.history, { version: nextBaselineVersion, action: 'rollback', fromVersion: current.baselineVersion, targetVersion, benchmarkRun: clone(target.benchmarkRun), at: now }], updatedAt: now }, expectedVersion);
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'benchmark-rollback', status: 'rolled_back', benchmarkSuiteId, previousVersion: current.baselineVersion, version: updated.baselineVersion, storeVersion: updated.version, targetVersion });
    await this.#emit('benchmark.baseline.rolled_back', result);
    return result;
  }

  async #emit(type, payload) {
    if (this.eventBus && typeof this.eventBus.emit === 'function') await this.eventBus.emit(type, payload);
  }
}

function stateId(benchmarkSuiteId) { return `benchmark-baseline:${benchmarkSuiteId}`; }
function validateSuiteId(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('benchmarkSuiteId must be a non-empty string'); }
function validateExpectedStoreVersion(value) { if (value !== null && (!Number.isInteger(value) || value < 0)) throw new TypeError('expectedVersion must be a non-negative integer or null'); }

function validateRun(run, label) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError(`${label} benchmark run must be an object`);
  if (run.type !== 'benchmark-run') throw new TypeError(`${label} benchmark run requires type benchmark-run`);
  validateSuiteId(run.benchmarkSuiteId);
  for (const field of ['caseCount', 'passed', 'failed', 'passRate']) if (!Number.isFinite(run[field]) || run[field] < 0) throw new TypeError(`${label} benchmark run requires a valid non-negative ${field}`);
  if (run.passRate > 1) throw new TypeError(`${label} benchmark run requires passRate between 0 and 1`);
  if (run.passed + run.failed !== run.caseCount) throw new TypeError(`${label} benchmark run counts must equal caseCount`);
  const expected = run.caseCount === 0 ? 0 : run.passed / run.caseCount;
  if (Math.abs(run.passRate - expected) > Number.EPSILON * 8) throw new TypeError(`${label} benchmark run passRate must match passed/caseCount`);
  if (!Array.isArray(run.suites)) throw new TypeError(`${label} benchmark run requires suites`);
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('Benchmark metadata must be an object');
  return structuredClone(metadata);
}
function conflict(message, code) { return Object.assign(new Error(message), { code, retryable: false }); }
function failure(code, message) { return Object.freeze({ schemaVersion: '0.1.0', type: 'benchmark-governance', status: 'failed', error: Object.freeze({ code, message }) }); }
function clone(value) { return structuredClone(value); }
