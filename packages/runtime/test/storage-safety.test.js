import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMissionStore, FileExecutionStateStore, ExecutionStateStore, MemoryCapability } from '../src/index.js';
async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'super-storage-')); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, 'state.json'); }
test('corrupt stores fail on every read and write without overwriting evidence', async (t) => {
  for (const Store of [FileMissionStore, FileExecutionStateStore]) {
    const file = await temporary(t); await writeFile(file, 'broken-json'); const store = new Store(file);
    await assert.rejects(store.list()); await assert.rejects(store.list());
    await assert.rejects(Store === FileMissionStore ? store.save({ missionId: 'x' }) : store.create({ executionId: 'x', type: 'execution-state' }));
    assert.equal(await readFile(file, 'utf8'), 'broken-json');
  }
});
test('simultaneous first reads share fully validated persistent state', async (t) => {
  const file = await temporary(t); const seed = new FileMissionStore(file); await seed.save({ missionId: 'seed' });
  const store = new FileMissionStore(file); const lists = await Promise.all(Array.from({ length: 12 }, () => store.list()));
  assert.ok(lists.every((list) => list.length === 1 && list[0].missionId === 'seed'));
});
test('mission writes serialize version checks and survive process-style reload', async (t) => {
  const file = await temporary(t); const store = new FileMissionStore(file); const initial = await store.save({ missionId: 'x' });
  const results = await Promise.allSettled([store.save({ missionId: 'x', status: 'a' }, initial.version), store.save({ missionId: 'x', status: 'b' }, initial.version)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await new FileMissionStore(file).get('x')).version, 1);
});
test('failed file writes preserve memory and do not poison later writes', async (t) => {
  for (const Store of [FileMissionStore, FileExecutionStateStore]) {
    const file = await temporary(t); const store = new Store(file);
    if (Store === FileMissionStore) await store.save({ missionId: 'old' }); else await store.create({ executionId: 'old', type: 'execution-state' });
    await rm(file); await mkdir(file);
    await assert.rejects(Store === FileMissionStore ? store.save({ missionId: 'new' }) : store.create({ executionId: 'new', type: 'execution-state' }));
    assert.equal((await store.list()).length, 1);
    await rm(file, { recursive: true });
    if (Store === FileMissionStore) await store.save({ missionId: 'new' }); else await store.create({ executionId: 'new', type: 'execution-state' });
    assert.equal((await new Store(file).list()).length, 2);
  }
});
test('invalid restores leave existing memory and execution state intact', async () => {
  const memory = new MemoryCapability({ idFactory: () => 'custom-id' }); memory.set('project', 'x', 1);
  const snapshot = memory.snapshot(); memory.restore(snapshot); assert.equal(memory.get('project', 'x').id, 'custom-id');
  await assert.rejects(async () => memory.restore({ ...snapshot, records: [...snapshot.records, { namespace: 'bad', key: 'bad', id: '', version: 0 }] }));
  assert.equal(memory.get('project', 'x').value, 1);
  const state = new ExecutionStateStore(); await state.create({ executionId: 'x', type: 'execution-state' });
  await assert.rejects(state.restore([{ executionId: 'bad', type: 'execution-state', version: 0 }, {}]));
  assert.equal((await state.list()).length, 1); assert.ok(await state.get('x'));
});
