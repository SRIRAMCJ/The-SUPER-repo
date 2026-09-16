import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityCatalog, CapabilityResolver } from '../src/index.js';

function makeEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `software.capability-${index}`,
    version: '1.0.0',
    domain: 'software',
    kind: 'skill',
    name: `Capability ${index}`,
    description: 'Synthetic resolver benchmark capability',
    requires: index ? [`software.capability-${index - 1}`] : [],
    status: 'stable'
  }));
}

test('resolver handles a 10000-node dependency chain without recursion', () => {
  const catalog = new CapabilityCatalog(makeEntries(10_000));
  const resolver = new CapabilityResolver({ registry: catalog });
  const started = performance.now();
  const result = resolver.resolve({ capabilityId: 'software.capability-9999' });
  const elapsed = performance.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.order.length, 10_000);
  assert.equal(result.order[0], 'software.capability-0');
  assert.equal(result.order.at(-1), 'software.capability-9999');
  assert.ok(Number.isFinite(elapsed));
});
