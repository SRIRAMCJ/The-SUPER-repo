import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, filterFindings } from '../dist/report.js';

const report = {
  schemaVersion: '0.1.0', type: 'static-javascript-investigation', target: '/fixture', query: null,
  files: [{ path: 'api.ts', bytes: 5, sha256: 'a'.repeat(64) }], skipped: [], limitations: [],
  findings: [{ kind: 'route', value: '/search', evidence: { path: 'api.ts', line: 1, column: 1, sha256: 'a'.repeat(64) } }]
};

test('loads an investigation report and filters by value and source path', () => {
  const parsed = parseReport(report);
  assert.equal(filterFindings(parsed, 'SEARCH').length, 1);
  assert.equal(filterFindings(parsed, 'API.TS').length, 1);
  assert.equal(filterFindings(parsed, 'missing').length, 0);
});

test('rejects a malformed report before rendering', () => {
  assert.throws(() => parseReport({ ...report, findings: [{ kind: 'route' }] }), /Invalid/);
});
