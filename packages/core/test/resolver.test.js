import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityCatalog, CapabilityResolver, ExecutionPlanBuilder } from '../src/index.js';

const capability = (id, requires = [], extra = {}) => ({
  id,
  version: '1.0.0',
  domain: 'software',
  kind: 'skill',
  name: id.split('.').at(-1),
  description: id,
  requires,
  status: 'stable',
  ...extra
});

const catalog = (entries) => new CapabilityCatalog(entries);

test('resolves dependencies in deterministic topological order', () => {
  const c = catalog([
    capability('software.root', ['software.b', 'software.a']),
    capability('software.b', ['software.base']),
    capability('software.a', ['software.base']),
    capability('software.base')
  ]);
  const result = new CapabilityResolver({ registry: c }).resolve({ capabilityId: 'software.root' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ['software.base', 'software.a', 'software.b', 'software.root']);
});

test('reports missing dependencies instead of silently dropping them', () => {
  const c = catalog([capability('software.root', ['software.missing'])]);
  const result = new CapabilityResolver({ registry: c }).resolve({ capabilityId: 'software.root' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEPENDENCY_MISSING');
  assert.deepEqual(result.error.missing, [{ id: 'software.missing', requiredBy: 'software.root' }]);
});

test('detects dependency cycles', () => {
  const c = catalog([
    capability('software.a', ['software.b']),
    capability('software.b', ['software.a'])
  ]);
  const result = new CapabilityResolver({ registry: c }).resolve({ capabilityId: 'software.a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEPENDENCY_CYCLE');
});

test('enforces domain constraints across the dependency graph', () => {
  const c = catalog([
    capability('software.root', ['data.helper']),
    capability('data.helper', [], { domain: 'data' })
  ]);
  const result = new CapabilityResolver({ registry: c }).resolve({ capabilityId: 'software.root', domain: 'software' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEPENDENCY_DOMAIN_MISMATCH');
});

test('reports duplicate dependency edges without changing the execution graph', () => {
  const c = catalog([
    capability('software.root', ['software.base', 'software.base']),
    capability('software.base')
  ]);
  const result = new CapabilityResolver({ registry: c }).resolve({ capabilityId: 'software.root' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ['software.base', 'software.root']);
  assert.deepEqual(result.duplicateDependencies, [{ capabilityId: 'software.root', dependencyId: 'software.base' }]);
});

test('rejects unavailable capabilities', () => {
  const c = catalog([capability('software.root', [], { status: 'deprecated' })]);
  const result = new CapabilityResolver({ registry: c }).resolve({ capabilityId: 'software.root' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CAPABILITY_UNAVAILABLE');
});

test('builds a reproducible execution plan', () => {
  const c = catalog([
    capability('software.root', ['software.base']),
    capability('software.base')
  ]);
  const resolver = new CapabilityResolver({ registry: c });
  const builder = new ExecutionPlanBuilder({ resolver, clock: () => new Date('2026-01-01T00:00:00.000Z') });
  const plan = builder.build({ capabilityId: 'software.root' });
  assert.equal(plan.ok, true);
  assert.equal(plan.metadata.deterministic, true);
  assert.deepEqual(plan.steps.map((step) => step.capabilityId), ['software.base', 'software.root']);
  assert.equal(plan.steps[1].execution, 'root');
});

test('returns structured failure for unknown capability', () => {
  const resolver = new CapabilityResolver({ registry: catalog([]) });
  const plan = new ExecutionPlanBuilder({ resolver }).build({ capabilityId: 'software.unknown' });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, 'CAPABILITY_NOT_FOUND');
});
