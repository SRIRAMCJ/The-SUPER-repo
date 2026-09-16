import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRepositoryAnalystRuntime } from '../src/index.js';

test('repository analyst executes mission, verifies report, and records lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'super-repo-analyst-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'README.md'), '# Fixture\n');
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }));
    await writeFile(path.join(root, 'src', 'index.js'), 'export const value = 1;\n');

    const runtime = createRepositoryAnalystRuntime();
    const result = await runtime.mission.execute(runtime.manifests.mission, { repositoryPath: root });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.output.type, 'repository-analysis');
    assert.equal(result.output.repository.name, path.basename(root));
    assert.ok(result.output.inventory.files >= 4);
    assert.equal(result.verification.verified, true);
    assert.equal(runtime.events.history({ type: 'execution.verified' }).length, 1);
    assert.equal(runtime.events.history({ type: 'execution.completed' }).length, 1);
    assert.equal(runtime.events.history({ type: 'mission.completed' }).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repository analyst flags missing README and test script', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'super-repo-analyst-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const runtime = createRepositoryAnalystRuntime();
    const result = await runtime.mission.execute(runtime.manifests.mission, { repositoryPath: root });
    assert.equal(result.status, 'succeeded');
    assert.ok(result.output.findings.some((item) => item.id === 'repo/missing-readme'));
    assert.ok(result.output.findings.some((item) => item.id.startsWith('quality/no-test-script:')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
