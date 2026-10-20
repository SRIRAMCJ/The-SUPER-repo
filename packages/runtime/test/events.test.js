import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/index.js';

test('EventBus bounds history and returns isolated snapshots', () => {
  const bus = new EventBus({ maxHistory: 2, clock: () => new Date('2026-09-17T10:00:00.000Z'), idFactory: () => 'evt_test' });
  bus.emit({ type: 'one', data: { value: 1 } });
  bus.emit({ type: 'two' });
  bus.emit({ type: 'three' });
  const history = bus.history();
  assert.deepEqual(history.map((event) => event.type), ['two', 'three']);
  history[0].data = 'mutated';
  assert.equal(bus.history()[0].type, 'two');
});

test('EventBus validates event and listener contracts', () => {
  const bus = new EventBus();
  assert.throws(() => bus.emit(null), /Event must be an object/);
  assert.throws(() => bus.emit({}), /Event requires/);
  assert.throws(() => bus.on('', () => {}), /non-empty string/);
  assert.throws(() => bus.on('x', null), /listener must be a function/);
});

test('EventBus listener failures remain visible to the caller', () => {
  const bus = new EventBus();
  bus.on('failure', () => { throw new Error('listener failed'); });
  assert.throws(() => bus.emit({ type: 'failure' }), /listener failed/);
  assert.equal(bus.history().length, 1);
});

test('event data is isolated across inputs, listeners, results, and history', () => {
  const bus = new EventBus();
  let observed;
  bus.on('sample', (event) => { event.data.value = 99; });
  bus.on('*', (event) => { observed = event.data.value; });
  const input = { type: 'sample', data: { value: 1 } };
  const result = bus.emit(input);
  input.data.value = 2;
  result.data.value = 3;
  bus.history()[0].data.value = 4;
  assert.equal(observed, 1);
  assert.equal(bus.history()[0].data.value, 1);
});

test('EventBus uses injected metadata defaults and preserves explicit metadata', () => {
  const bus = new EventBus({ clock: () => new Date('2026-10-06T00:00:00Z'), idFactory: () => 'injected' });
  assert.equal(bus.emit({ type: 'default', id: undefined }).id, 'injected');
  assert.equal(bus.history()[0].timestamp, '2026-10-06T00:00:00.000Z');
  const result = bus.emit({ type: 'explicit', id: 'source', timestamp: '2026-01-01T00:00:00Z', schemaVersion: '0.2.0' });
  assert.equal(result.id, 'source');
  assert.equal(result.schemaVersion, '0.2.0');
  assert.equal(result.timestamp, '2026-01-01T00:00:00Z');
});

test('EventBus validates retention and supports unsubscribe without duplicate wildcard delivery', () => {
  for (const maxHistory of [0, -1, 1.5, Infinity]) assert.throws(() => new EventBus({ maxHistory }), /positive integer/);
  assert.throws(() => new EventBus({ clock: null }), /functions/);
  assert.throws(() => new EventBus({ idFactory: null }), /functions/);
  const bus = new EventBus();
  let calls = 0;
  const unsubscribe = bus.on('*', () => calls++);
  bus.emit({ type: '*' });
  assert.equal(calls, 1);
  unsubscribe();
  bus.emit({ type: 'later' });
  assert.equal(calls, 1);
});

test('history filters before limiting and rejects invalid queries', () => {
  const bus = new EventBus();
  bus.emit({ type: 'match', data: 1 });
  bus.emit({ type: 'other' });
  bus.emit({ type: 'match', data: 2 });
  assert.deepEqual(bus.history({ type: 'match' }, 1).map((event) => event.data), [2]);
  assert.throws(() => bus.history(null), /filter must be an object/);
  assert.throws(() => bus.history({}, 0), /positive integer/);
});
