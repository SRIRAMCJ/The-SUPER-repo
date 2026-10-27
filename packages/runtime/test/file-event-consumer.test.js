import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FileEventJournal, FileEventConsumer } from '../src/index.js';

async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-event-consumer-'));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a shared checkpoint serializes delivery across processes and resumes after restart', () => temporary(async (directory) => {
  const journalPath = path.join(directory, 'journal');
  const checkpointPath = path.join(directory, 'consumer.json');
  const outputPath = path.join(directory, 'delivered.txt');
  const journal = new FileEventJournal(journalPath);
  for (let id = 1; id <= 5; id++) await journal.append({ type: 'work', id });
  const moduleUrl = new URL('../src/index.js', import.meta.url).href;
  const script = `import { appendFile } from 'node:fs/promises'; import { FileEventJournal, FileEventConsumer } from ${JSON.stringify(moduleUrl)};
    const consumer = new FileEventConsumer({ journal: new FileEventJournal(process.argv[1]), checkpointPath: process.argv[2], batchSize: 3,
      listener: async (event) => appendFile(process.argv[3], event.id + '\\n') }); console.log(JSON.stringify(await consumer.runOnce()));`;
  const results = await Promise.all(Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, journalPath, checkpointPath, outputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || `consumer exited ${code}`)));
  })));
  assert.equal(results.reduce((total, item) => total + item.delivered, 0), 5);
  assert.deepEqual((await readFile(outputPath, 'utf8')).trim().split('\n').map(Number), [1, 2, 3, 4, 5]);
  const restarted = new FileEventConsumer({ journal, checkpointPath, listener: () => assert.fail('duplicate delivery') });
  assert.equal((await restarted.runOnce()).delivered, 0);
}));

test('listener failure preserves checkpoint and repeats the uncertain event', () => temporary(async (directory) => {
  const journal = new FileEventJournal(path.join(directory, 'journal'));
  await journal.append({ type: 'work', id: 1 });
  await journal.append({ type: 'work', id: 2 });
  const checkpointPath = path.join(directory, 'consumer.json');
  const seen = [];
  const first = new FileEventConsumer({ journal, checkpointPath, listener: (event) => {
    seen.push(event.id);
    if (event.id === 2) throw new Error('uncertain effect');
  } });
  await assert.rejects(first.runOnce(), /uncertain effect/);
  assert.deepEqual(seen, [1, 2]);
  const second = new FileEventConsumer({ journal, checkpointPath, listener: (event) => seen.push(event.id) });
  assert.equal((await second.runOnce()).delivered, 1);
  assert.deepEqual(seen, [1, 2, 2]);
  await unlink(checkpointPath);
  await assert.rejects(new FileEventConsumer({ journal, checkpointPath, listener: () => {} }).runOnce(), { code: 'EVENT_CHECKPOINT_MISSING' });
}));

test('a forged cursor and corrupt checkpoint fail closed', () => temporary(async (directory) => {
  const journal = new FileEventJournal(path.join(directory, 'journal'));
  await journal.append({ type: 'work' });
  const checkpointPath = path.join(directory, 'consumer.json');
  const consumer = new FileEventConsumer({ journal, checkpointPath, listener: () => {} });
  await consumer.runOnce();
  await writeFile(checkpointPath, JSON.stringify({ sequence: 1, hash: 'f'.repeat(64) }));
  await assert.rejects(new FileEventConsumer({ journal, checkpointPath, listener: () => {} }).runOnce(), { code: 'EVENT_JOURNAL_CORRUPT' });
}));

test('a killed consumer releases its lock and retries an effect without a checkpoint', () => temporary(async (directory) => {
  const journalPath = path.join(directory, 'journal');
  const checkpointPath = path.join(directory, 'checkpoint.json');
  const effectPath = path.join(directory, 'effect.txt');
  await new FileEventJournal(journalPath).append({ type: 'work', id: 'same-event' });
  const moduleUrl = new URL('../src/index.js', import.meta.url).href;
  const script = `import { appendFile } from 'node:fs/promises'; import { FileEventJournal, FileEventConsumer } from ${JSON.stringify(moduleUrl)};
    await new FileEventConsumer({ journal: new FileEventJournal(process.argv[1]), checkpointPath: process.argv[2],
      listener: async (event) => { await appendFile(process.argv[3], event.id + '\\n'); console.log('effect'); await new Promise(() => {}); } }).runOnce();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, journalPath, checkpointPath, effectPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let timer;
    try {
      await Promise.race([new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (chunk.toString().includes('effect')) resolve(); });
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`consumer exited ${code}`)));
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('effect did not start')), 3000); })]);
    } finally { clearTimeout(timer); }
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
    const replacement = new FileEventConsumer({ journal: new FileEventJournal(journalPath), checkpointPath,
      listener: (event) => appendFile(effectPath, `${event.id}\n`) });
    assert.equal((await replacement.runOnce()).delivered, 1);
    assert.deepEqual((await readFile(effectPath, 'utf8')).trim().split('\n'), ['same-event', 'same-event']);
  } finally { child.kill('SIGKILL'); }
}));
