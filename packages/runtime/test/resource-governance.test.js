import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeResourceGovernance } from '../src/resource-governance.js';

test('admits resources within global limits and releases allocation', () => {
  const governance = new RuntimeResourceGovernance({ limits: { concurrency: 2, cpuMs: 1000 } });
  const first = governance.admit({ executionId: 'e1', request: { concurrency: 1, cpuMs: 100 } });
  assert.equal(first.allowed, true);
  assert.equal(governance.allocation('e1').allocation.concurrency, 1);
  assert.equal(governance.totals().totals.concurrency, 1);
  governance.release('e1', { concurrency: 1, cpuMs: 100 });
  assert.equal(governance.allocation('e1').allocation.concurrency, 0);
  assert.equal(governance.totals().totals.concurrency, 0);
});

test('denies a request that would exceed the global resource budget', () => {
  const governance = new RuntimeResourceGovernance({ limits: { memoryBytes: 100 } });
  assert.equal(governance.admit({ executionId: 'e1', request: { memoryBytes: 80 } }).allowed, true);
  const denied = governance.admit({ executionId: 'e2', request: { memoryBytes: 30 } });
  assert.equal(denied.allowed, false);
  assert.equal(denied.resource, 'memoryBytes');
  assert.equal(denied.scope, 'global');
  assert.equal(governance.totals().totals.memoryBytes, 80);
});

test('supports an independent per-execution resource budget', () => {
  const governance = new RuntimeResourceGovernance({ limits: { memoryBytes: 1000 }, executionLimits: { memoryBytes: 100 } });
  assert.equal(governance.admit({ executionId: 'e1', request: { memoryBytes: 80 } }).allowed, true);
  const denied = governance.admit({ executionId: 'e1', request: { memoryBytes: 30 } });
  assert.equal(denied.allowed, false);
  assert.equal(denied.resource, 'memoryBytes');
  assert.equal(denied.scope, 'e1');
  assert.equal(governance.totals().totals.memoryBytes, 80);
});

test('bounds immutable decision history', () => {
  const governance = new RuntimeResourceGovernance({ maxHistory: 2 });
  governance.admit({ executionId: 'e1', request: { concurrency: 1 } });
  governance.release('e1', { concurrency: 1 });
  governance.admit({ executionId: 'e2', request: { concurrency: 1 } });
  assert.equal(governance.history().length, 2);
});

test('rejects reconfiguration below currently reserved resources', () => {
  const governance = new RuntimeResourceGovernance({ limits: { memoryBytes: 100 } });
  governance.admit({ executionId: 'e1', request: { memoryBytes: 80 } });
  assert.throws(() => governance.configure({ memoryBytes: 50 }), /current allocation/);
  assert.equal(governance.totals().totals.memoryBytes, 80);
});
