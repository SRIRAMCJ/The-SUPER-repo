export class BenchmarkRegressionEngine {
  compare(baseline, candidate, gates = {}) {
    validateRun(baseline, 'baseline');
    validateRun(candidate, 'candidate');
    if (baseline.benchmarkSuiteId !== candidate.benchmarkSuiteId) {
      return failure('BENCHMARK_MISMATCH', 'Baseline and candidate benchmark IDs differ');
    }

    const baselineSuites = indexSuites(baseline);
    const candidateSuites = indexSuites(candidate);
    const suiteIds = [...new Set([...baselineSuites.keys(), ...candidateSuites.keys()])].sort();
    const suites = suiteIds.map((suiteId) => compareSuite(baselineSuites.get(suiteId), candidateSuites.get(suiteId), suiteId));
    const passRateDelta = candidate.passRate - baseline.passRate;
    const failedDelta = candidate.failed - baseline.failed;
    const thresholds = normalizeGates(gates);
    const violations = [];

    if (thresholds.minPassRate !== null && candidate.passRate < thresholds.minPassRate) {
      violations.push({ code: 'MIN_PASS_RATE', expected: thresholds.minPassRate, actual: candidate.passRate });
    }
    if (thresholds.maxPassRateDrop !== null && -passRateDelta > thresholds.maxPassRateDrop) {
      violations.push({ code: 'PASS_RATE_DROP', expected: thresholds.maxPassRateDrop, actual: -passRateDelta });
    }
    if (thresholds.maxFailureIncrease !== null && failedDelta > thresholds.maxFailureIncrease) {
      violations.push({ code: 'FAILURE_INCREASE', expected: thresholds.maxFailureIncrease, actual: failedDelta });
    }

    return Object.freeze({
      schemaVersion: '0.1.0',
      type: 'benchmark-regression',
      status: violations.length === 0 ? 'passed' : 'failed',
      baselineBenchmarkId: baseline.benchmarkSuiteId,
      candidateBenchmarkId: candidate.benchmarkSuiteId,
      baseline: summary(baseline),
      candidate: summary(candidate),
      deltas: Object.freeze({ passRate: passRateDelta, failed: failedDelta, passed: candidate.passed - baseline.passed }),
      suites: Object.freeze(suites.map(Object.freeze)),
      gates: Object.freeze(thresholds),
      violations: Object.freeze(violations.map(Object.freeze))
    });
  }
}

function validateRun(run, label) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError(`${label} benchmark run must be an object`);
  if (run.type !== 'benchmark-run') throw new TypeError(`${label} benchmark run requires type benchmark-run`);
  for (const field of ['benchmarkSuiteId', 'caseCount', 'passed', 'failed', 'passRate']) {
    if (run[field] === undefined) throw new TypeError(`${label} benchmark run requires ${field}`);
  }
  if (!Array.isArray(run.suites)) throw new TypeError(`${label} benchmark run requires suites`);
}

function indexSuites(run) {
  const map = new Map();
  for (const suite of run.suites) {
    if (!suite || typeof suite.suiteId !== 'string' || map.has(suite.suiteId)) throw new TypeError('Benchmark run suites require unique suiteId values');
    map.set(suite.suiteId, suite);
  }
  return map;
}

function compareSuite(baseline, candidate, suiteId) {
  if (!baseline || !candidate) return { suiteId, status: 'changed', baselinePresent: Boolean(baseline), candidatePresent: Boolean(candidate) };
  return {
    suiteId,
    status: baseline.status === candidate.status && baseline.passed === candidate.passed && baseline.failed === candidate.failed ? 'unchanged' : 'changed',
    baseline: { status: baseline.status, passed: baseline.passed, failed: baseline.failed },
    candidate: { status: candidate.status, passed: candidate.passed, failed: candidate.failed }
  };
}

function summary(run) {
  return { caseCount: run.caseCount, passed: run.passed, failed: run.failed, passRate: run.passRate, status: run.status };
}

function normalizeGates(gates) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw new TypeError('Benchmark gates must be an object');
  const values = {
    minPassRate: gates.minPassRate,
    maxPassRateDrop: gates.maxPassRateDrop,
    maxFailureIncrease: gates.maxFailureIncrease
  };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || (name === 'minPassRate' && value > 1))) throw new TypeError(`Benchmark gate ${name} must be a valid non-negative number`);
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null]));
}

function failure(code, message) {
  return Object.freeze({ schemaVersion: '0.1.0', type: 'benchmark-regression', status: 'failed', error: Object.freeze({ code, message }) });
}
