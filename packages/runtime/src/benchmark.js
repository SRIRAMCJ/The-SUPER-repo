import { createExecutionId } from './events.js';

export class BenchmarkEngine {
  constructor({ evaluationEngine, clock = () => new Date() } = {}) {
    if (!evaluationEngine || typeof evaluationEngine.run !== 'function') throw new TypeError('BenchmarkEngine requires evaluationEngine');
    this.evaluationEngine = evaluationEngine;
    this.clock = clock;
  }

  async run(benchmark, context = {}) {
    validateBenchmark(benchmark);
    const benchmarkId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const suites = [...benchmark.suites].sort((a, b) => a.id.localeCompare(b.id));
    const results = [];

    for (const suite of suites) results.push(await this.evaluationEngine.run(suite, { ...context, benchmarkId, benchmarkSuiteId: suite.id }));

    const caseCount = results.reduce((sum, result) => sum + result.caseCount, 0);
    const passed = results.reduce((sum, result) => sum + result.passed, 0);
    const failed = caseCount - passed;
    return Object.freeze({
      schemaVersion: '0.1.0',
      type: 'benchmark-run',
      benchmarkId,
      benchmarkSuiteId: benchmark.id,
      startedAt,
      finishedAt: this.clock().toISOString(),
      status: failed === 0 ? 'succeeded' : 'failed',
      suiteCount: results.length,
      caseCount,
      passed,
      failed,
      passRate: caseCount === 0 ? 0 : passed / caseCount,
      suites: Object.freeze(results.map((result) => Object.freeze(result)))
    });
  }
}

function validateBenchmark(benchmark) {
  if (!benchmark || typeof benchmark !== 'object' || Array.isArray(benchmark)) throw new TypeError('Benchmark must be an object');
  if (typeof benchmark.id !== 'string' || !benchmark.id.trim()) throw new TypeError('Benchmark requires id');
  if (!Array.isArray(benchmark.suites) || benchmark.suites.length === 0) throw new TypeError('Benchmark requires at least one suite');
  const ids = new Set();
  for (const suite of benchmark.suites) {
    if (!suite || typeof suite.id !== 'string' || !suite.id.trim() || ids.has(suite.id)) throw new TypeError('Benchmark suites require unique ids');
    ids.add(suite.id);
  }
}
