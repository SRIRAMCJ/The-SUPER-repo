import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCapability } from '../src/memory-capability.js';

test('isolates namespace/key identities and returns immutable snapshots', () => {
  const memory = new MemoryCapability({ idFactory: () => 'memory-1' });
  const created = memory.set('agent-a', 'goal', { value: 1 }, { metadata: { source: 'test' } });
  assert.equal(created.version, 1);
  const loaded = memory.get('agent-a', 'goal');
  loaded.value.value = 99;
  assert.equal(memory.get('agent-a', 'goal').value.value, 1);
  assert.equal(memory.get('agent-b', 'goal'), null);
});

test('supports optimistic concurrency and compare-and-set', () => {
  const memory = new MemoryCapability();
  const first = memory.set('agent', 'state', 'one');
  const second = memory.compareAndSet('agent', 'state', first.version, 'two');
  assert.equal(second.version, 2);
  assert.throws(() => memory.set('agent', 'state', 'three', { expectedVersion: 1 }), /Memory version conflict/);
});

test('expires records deterministically', () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const memory = new MemoryCapability({ clock: () => now });
  memory.set('agent', 'temporary', 'value', { ttlMs: 1000 });
  assert.equal(memory.get('agent', 'temporary')?.value, 'value');
  now = new Date('2026-01-01T00:00:01.001Z');
  assert.equal(memory.get('agent', 'temporary'), null);
});

test('enforces bounded retention and namespace clearing', () => {
  const memory = new MemoryCapability({ maxEntries: 2 });
  memory.set('a', 'one', 1);
  memory.set('a', 'two', 2);
  memory.set('b', 'three', 3);
  assert.equal(memory.list().length, 2);
  assert.equal(memory.list('a').length, 1);
  assert.equal(memory.clear('a'), 1);
  assert.equal(memory.list().length, 1);
});

test('restores validated snapshots without sharing mutable state', () => {
  const source = new MemoryCapability();
  source.set('agent', 'x', { nested: true });
  const snapshot = source.snapshot();
  const target = new MemoryCapability();
  target.restore(snapshot);
  const loaded = target.get('agent', 'x');
  loaded.value.nested = false;
  assert.equal(target.get('agent', 'x').value.nested, true);
  assert.throws(() => target.restore({ schemaVersion: 'bad', records: [] }), /Invalid memory snapshot/);
});
