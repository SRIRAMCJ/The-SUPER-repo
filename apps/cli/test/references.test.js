import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const catalog = new URL('../../../docs/reference-adoption.json', import.meta.url);
const cli = new URL('../src/index.js', import.meta.url);

test('adoption catalog has unique sources, bounded phases, and honest status', async () => {
  const { references } = JSON.parse(await readFile(catalog, 'utf8'));
  assert.equal(references.length, 27);
  assert.equal(new Set(references.map(({ url }) => url.toLowerCase())).size, references.length);
  for (const entry of references) {
    assert.match(entry.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    assert.ok(Number.isInteger(entry.phase) && entry.phase >= 1 && entry.phase <= 8);
    assert.equal(entry.status, 'reference');
    assert.ok(entry.acceptance.length >= 3);
  }
});

test('CLI filters reference catalog without claiming integrations are installed', () => {
  const output = execFileSync(process.execPath, [cli.pathname, 'references', '--phase=7', '--json'], { encoding: 'utf8' });
  const { references } = JSON.parse(output);
  assert.ok(references.length > 0);
  assert.ok(references.every((entry) => entry.phase === 7 && entry.status === 'reference'));
});
