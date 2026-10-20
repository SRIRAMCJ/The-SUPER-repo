import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { investigateJavaScript } from '../src/index.js';

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'super-re-'));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('traces static module, route and Electron IPC evidence with digest and line', () => fixture(async (root) => {
  await writeFile(path.join(root, 'app.js'), "import api from './api.js';\napp.get('/search', handler);\nipcMain.handle('lookup', handler);\n");
  const report = await investigateJavaScript(root, { query: 'lookup' });
  assert.equal(report.files.length, 1);
  assert.deepEqual(report.findings.map((item) => [item.kind, item.value, item.evidence.line]), [['electron-ipc', 'lookup', 3]]);
  assert.match(report.findings[0].evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.limitations.length, 3);
}));

test('inspects TypeScript and TSX imports, declarations, and routes', () => fixture(async (root) => {
  await writeFile(path.join(root, 'api.ts'), "import type { Search } from './types';\nexport interface SearchRequest { query: string }\nexport type Result = string;\nrouter.get('/search', handler);\n");
  await writeFile(path.join(root, 'view.tsx'), "import React from 'react';\nexport const SearchView = () => <div />;\n");
  const report = await investigateJavaScript(root);
  assert.deepEqual(report.files.map((file) => file.path), ['api.ts', 'view.tsx']);
  assert.deepEqual(report.findings.map(({ kind, value }) => [kind, value]), [
    ['module-import', './types'], ['typescript-declaration', 'SearchRequest'],
    ['typescript-declaration', 'Result'], ['route', '/search'],
    ['module-import', 'react'], ['module-export', 'SearchView']
  ]);
}));

test('never follows symlinks, excludes dependency trees and reports size limits', () => fixture(async (root) => {
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'evil.js'), "app.get('/hidden', handler)");
  await writeFile(path.join(root, 'large.js'), 'x'.repeat(100));
  await symlink(path.join(root, 'node_modules'), path.join(root, 'linked'));
  const report = await investigateJavaScript(root, { maxBytes: 10 });
  assert.deepEqual(report.files, []);
  assert.deepEqual(report.skipped.map((item) => item.reason).sort(), ['size-limit', 'symlink']);
}));

test('rejects invalid bounds and nonregular targets', () => fixture(async (root) => {
  await assert.rejects(investigateJavaScript(root, { maxFiles: 0 }), /maxFiles/);
  await symlink(root, path.join(root, 'linked'));
  await assert.rejects(investigateJavaScript(path.join(root, 'linked')), /regular file or directory/);
}));
