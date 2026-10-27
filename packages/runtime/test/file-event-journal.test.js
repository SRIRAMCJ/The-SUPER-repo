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

test('explicit compaction frees bounded capacity and exposes gaps to old cursors', () => temporary(async (directory) => {
  const journal = new FileEventJournal(directory, { maxRecords: 3 });
  const first = await journal.append({ type: 'one' });
  const second = await journal.append({ type: 'two' });
  await journal.append({ type: 'three' });
  await assert.rejects(journal.append({ type: 'full' }), { code: 'EVENT_JOURNAL_CAPACITY' });
  await assert.rejects(journal.compactThrough(2, first.hash), { code: 'EVENT_JOURNAL_CURSOR_INVALID' });
  await journal.compactThrough(2, second.hash);
  await assert.rejects(journal.replay(), { code: 'EVENT_JOURNAL_GAP' });
  await assert.rejects(journal.readFrom({ afterSequence: 1, afterHash: first.hash }), { code: 'EVENT_JOURNAL_GAP' });
  assert.deepEqual((await journal.replay({ afterSequence: 2 })).events, [{ sequence: 3, event: { type: 'three' } }]);
  assert.equal((await journal.readFrom({ afterSequence: 2, afterHash: second.hash })).events.length, 1);
  assert.equal((await journal.append({ type: 'four' })).sequence, 4);
  await journal.compactThrough(2, second.hash);
  await assert.rejects(journal.readFrom({ afterSequence: 2, afterHash: first.hash }), { code: 'EVENT_JOURNAL_CURSOR_INVALID' });
  await assert.rejects(readFile(path.join(directory, '000000000001.json')), { code: 'ENOENT' });
  const restarted = new FileEventJournal(directory, { maxRecords: 3 });
  assert.equal((await restarted.replay({ afterSequence: 2 })).events.length, 2);
}));

test('explicit orphan recovery promotes one valid interrupted record and rejects corruption', () => temporary(async (directory) => {
  const journal = new FileEventJournal(directory);
  await journal.append({ type: 'one' });
  const committedHead = await readFile(path.join(directory, 'head.json'), 'utf8');
  await journal.append({ type: 'two' });
  await writeFile(path.join(directory, 'head.json'), committedHead);
  await assert.rejects(journal.replay(), { code: 'EVENT_JOURNAL_CORRUPT' });
  const recovered = await new FileEventJournal(directory).recoverOrphan();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.head.sequence, 2);
  assert.deepEqual((await journal.replay()).events.map((item) => item.event.type), ['one', 'two']);
  assert.equal((await journal.recoverOrphan()).recovered, false);
  const head = await readFile(path.join(directory, 'head.json'), 'utf8');
  await journal.append({ type: 'three' });
  await writeFile(path.join(directory, 'head.json'), head);
  const orphanPath = path.join(directory, '000000000003.json');
  await writeFile(orphanPath, (await readFile(orphanPath, 'utf8')).replace('three', 'corrupt'));
  await assert.rejects(journal.recoverOrphan(), { code: 'EVENT_JOURNAL_CORRUPT' });
  assert.equal(JSON.parse(await readFile(path.join(directory, 'head.json'), 'utf8')).sequence, 2);
}));
