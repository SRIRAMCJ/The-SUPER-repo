import { createExecutionId } from './events.js';

export class EvaluationEngine {
  constructor({ executionEngine, clock = () => new Date() } = {}) {
    if (!executionEngine || typeof executionEngine.execute !== 'function') throw new TypeError('EvaluationEngine requires executionEngine');
    this.executionEngine = executionEngine;
    this.clock = clock;
  }

  async run(suite, context = {}) {
    validateSuite(suite);
    const evaluationId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const cases = [...suite.cases].sort((a, b) => a.id.localeCompare(b.id));
    const results = [];

    for (const testCase of cases) {
      const actual = await this.executionEngine.execute(testCase.capabilityId, testCase.input ?? {}, { ...context, evaluationId, evaluationCaseId: testCase.id });
      const assertions = evaluateAssertions(testCase.expected ?? {}, actual);
      results.push({ caseId: testCase.id, capabilityId: testCase.capabilityId, status: assertions.every((item) => item.ok) ? 'passed' : 'failed', assertions, actual });
    }

    const passed = results.filter((result) => result.status === 'passed').length;
    return Object.freeze({
      schemaVersion: '0.1.0',
      type: 'evaluation-run',
      evaluationId,
      suiteId: suite.id,
      startedAt,
      finishedAt: this.clock().toISOString(),
      status: passed === results.length ? 'succeeded' : 'failed',
      caseCount: results.length,
      passed,
      failed: results.length - passed,
      results: Object.freeze(results.map((result) => Object.freeze(result)))
    });
  }
}

function validateSuite(suite) {
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) throw new TypeError('Evaluation suite must be an object');
  if (typeof suite.id !== 'string' || !suite.id.trim()) throw new TypeError('Evaluation suite requires id');
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) throw new TypeError('Evaluation suite requires at least one case');
  const ids = new Set();
  for (const testCase of suite.cases) {
    if (!testCase || typeof testCase.id !== 'string' || !testCase.id.trim() || ids.has(testCase.id)) throw new TypeError('Evaluation cases require unique ids');
    if (typeof testCase.capabilityId !== 'string' || !testCase.capabilityId.trim()) throw new TypeError(`Evaluation case ${testCase.id} requires capabilityId`);
    ids.add(testCase.id);
  }
}

function evaluateAssertions(expected, actual) {
  const assertions = [];
  if (expected.status !== undefined) assertions.push(assertion('status', actual.status === expected.status, expected.status, actual.status));
  if (Object.prototype.hasOwnProperty.call(expected, 'output')) assertions.push(assertion('output', deepEqual(actual.output, expected.output), expected.output, actual.output));
  if (expected.errorCode !== undefined) assertions.push(assertion('errorCode', actual.error?.code === expected.errorCode, expected.errorCode, actual.error?.code ?? null));
  if (expected.verificationVerified !== undefined) assertions.push(assertion('verificationVerified', actual.verification?.verified === expected.verificationVerified, expected.verificationVerified, actual.verification?.verified ?? null));
  if (expected.outputContains !== undefined) {
    const haystack = typeof actual.output === 'string' ? actual.output : JSON.stringify(actual.output);
    const needles = Array.isArray(expected.outputContains) ? expected.outputContains : [expected.outputContains];
    for (const needle of needles) assertions.push(assertion('outputContains', haystack.includes(String(needle)), String(needle), haystack));
  }
  if (assertions.length === 0) assertions.push(assertion('status', actual.status === 'succeeded', 'succeeded', actual.status));
  return assertions;
}

function assertion(name, ok, expected, actual) { return { name, ok, expected, actual }; }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
