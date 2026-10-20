import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStaticInvestigationRuntime, verifyInvestigation } from '../src/runtime.js';

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'super-re-runtime-'));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('investigator executes through registry, policy, verification and audit', () => fixture(async (root) => {
  await writeFile(path.join(root, 'app.js'), "app.get('/search', handler);\n");
  const runtime = createStaticInvestigationRuntime();
  const result = await runtime.execution.execute(runtime.manifest.id, { targetPath: root, options: { query: 'search' } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.verification.verified, true);
  assert.equal(result.output.findings[0].value, '/search');
  assert.equal(runtime.audit.get(result.executionId).status, 'succeeded');
  assert.equal(runtime.events.history({ type: 'execution.verified' }).length, 1);
}));

test('policy denial occurs before filesystem access', async () => {
  const runtime = createStaticInvestigationRuntime({ policies: [() => ({ allowed: false, reason: 'Outside authorized scope' })] });
  const result = await runtime.execution.execute(runtime.manifest.id, { targetPath: '/nonexistent-target' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'POLICY_DENIED');
  assert.equal(runtime.events.history({ type: 'execution.started' }).length, 0);
  assert.equal(runtime.audit.get(result.executionId).status, 'failed');
});

test('verifier rejects fabricated file references and altered digests', () => {
  const runtime = createStaticInvestigationRuntime();
  const output = { type: 'static-javascript-investigation', schemaVersion: '0.1.0', files: [{ path: 'a.js', sha256: 'a'.repeat(64) }], skipped: [], findings: [
    { kind: 'route', value: '/x', evidence: { path: 'other.js', sha256: 'a'.repeat(64), line: 1, column: 1 } }
  ] };
  assert.equal(verifyInvestigation({ capability: runtime.manifest, output }).ok, false);
  output.findings[0].evidence.path = 'a.js';
  output.findings[0].evidence.sha256 = 'b'.repeat(64);
  assert.equal(verifyInvestigation({ capability: runtime.manifest, output }).ok, false);
  output.findings[0].evidence.sha256 = 'a'.repeat(64);
  assert.equal(verifyInvestigation({ capability: runtime.manifest, output }).ok, true);
});
