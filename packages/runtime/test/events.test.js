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
