import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FileEventJournal, RuntimeEventTransport } from '../src/index.js';

async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-event-journal-'));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('persist before delivery, replay after restart, and reject journal failure before delivery', () => temporary(async (directory) => {
  const journal = new FileEventJournal(directory, { maxRecords: 2 });
  const transport = new RuntimeEventTransport({ journal });
  const received = [];
  transport.subscribe((event) => received.push(event.id));
  await transport.publish({ type: 'started', id: 1 });
  await transport.publish({ type: 'started', id: 2 });
  await assert.rejects(transport.publish({ type: 'started', id: 3 }), { code: 'EVENT_JOURNAL_CAPACITY' });
  assert.deepEqual(received, [1, 2]);
  await transport.close();
  const restarted = new FileEventJournal(directory, { maxRecords: 2 });
  const replay = await restarted.replay({ afterSequence: 1 });
  assert.deepEqual(replay.events, [{ sequence: 2, event: { type: 'started', id: 2 } }]);
  assert.equal(replay.head.sequence, 2);
}));

test('concurrent processes append unique ordered sequences', () => temporary(async (directory) => {
  const moduleUrl = new URL('../src/file-event-journal.js', import.meta.url).href;
  const script = `import { FileEventJournal } from ${JSON.stringify(moduleUrl)}; const journal = new FileEventJournal(process.argv[1]); console.log(JSON.stringify(await journal.append({ type: 'child', id: process.argv[2] })));`;
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`journal child exited ${code}`)));
  })));
  assert.deepEqual(results.map((item) => item.sequence).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal((await new FileEventJournal(directory).replay()).events.length, 5);
}));

test('missing records, altered payload, orphan append and missing head fail closed', () => temporary(async (directory) => {
  const journal = new FileEventJournal(directory);
  await journal.append({ type: 'one' });
  await journal.append({ type: 'two' });
  const first = path.join(directory, '000000000001.json');
  const original = await readFile(first, 'utf8');
  await writeFile(first, original.replace('one', 'tampered'));
  await assert.rejects(journal.replay(), { code: 'EVENT_JOURNAL_CORRUPT' });
  await writeFile(first, original);
  await unlink(first);
  await assert.rejects(journal.replay(), { code: 'EVENT_JOURNAL_CORRUPT' });
  await writeFile(first, original);
  await writeFile(path.join(directory, '000000000003.json'), '{}');
  await assert.rejects(journal.append({ type: 'three' }), { code: 'EVENT_JOURNAL_CORRUPT' });
  await unlink(path.join(directory, '000000000003.json'));
  await unlink(path.join(directory, 'head.json'));
  await assert.rejects(new FileEventJournal(directory).append({ type: 'reset' }), { code: 'EVENT_JOURNAL_MISSING' });
  await writeFile(path.join(directory, 'head.json'), 'null');
  await assert.rejects(new FileEventJournal(directory).append({ type: 'reset' }), { code: 'EVENT_JOURNAL_CORRUPT' });
}));
