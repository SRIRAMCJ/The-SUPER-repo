import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventTransport } from '../src/index.js';

test('transport preserves order, isolates subscriber mutations, and drains before close', async () => {
  const transport = new RuntimeEventTransport({ maxPending: 3 });
  const received = [];
  transport.subscribe(async (event) => { event.type = 'mutated'; await Promise.resolve(); received.push(`first:${event.id}`); });
  transport.subscribe((event) => { assert.equal(event.type, 'started'); received.push(`second:${event.id}`); });
  const a = transport.publish({ type: 'started', id: 1 });
  const b = transport.publish({ type: 'started', id: 2 });
  await transport.close();
  await Promise.all([a, b]);
  assert.deepEqual(received, ['second:1', 'first:1', 'second:2', 'first:2']);
  await assert.rejects(transport.publish({ type: 'started' }), { code: 'EVENT_TRANSPORT_CLOSED' });
});

test('slow subscribers enforce capacity and failures do not skip other subscribers', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const transport = new RuntimeEventTransport({ maxPending: 1 });
  let delivered = 0;
  transport.subscribe(async () => { await held; throw new Error('subscriber failed'); });
  transport.subscribe(() => { delivered++; });
  const first = transport.publish({ type: 'event' });
  await assert.rejects(transport.publish({ type: 'event' }), { code: 'EVENT_TRANSPORT_CAPACITY' });
  release();
  await assert.rejects(first, AggregateError);
  assert.equal(delivered, 1);
  await transport.close();
});
