import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cli = path.resolve('apps/cli/src/index.js');

test('CLI analyze --json returns a verified repository report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'super-cli-'));
  try {
    await writeFile(path.join(root, 'README.md'), '# CLI fixture\n');
    const result = await runNode([cli, 'analyze', root, '--json']);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'succeeded');
    assert.equal(parsed.output.type, 'repository-analysis');
    assert.equal(parsed.output.summary.findingCount >= 0, true);
    assert.equal(parsed.verification.verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI help is executable without repository access', async () => {
  const result = await runNode([cli, '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /super analyze/);
});

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
