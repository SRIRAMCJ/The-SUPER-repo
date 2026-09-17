import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeResourceGovernance } from '../src/resource-governance.js';

test('admits resources within limits and releases allocation', () => {
  const governance = new RuntimeResourceGovernance({ limits: { concurrency: 2, cpuMs: 1000 } });
  const first = governance.admit({ executionId: 'e1', request: { concurrency: 1, cpuMs: 100 } });
  assert.equal(first.allowed, true);
  assert.equal(governance.allocation('e1').allocation.concurrency, 1);
  governance.release('e1', { concurrency: 1, cpuMs: 100 });
  assert.equal(governance.allocation('e1').allocation.concurrency, 0);
});

test('denies allocations that exceed a resource limit', () => {
  const governance = new RuntimeResourceGovernance({ limits: { memoryBytes: 100 } });
  assert.equal(governance.admit({ executionId: 'e1', request: { memoryBytes: 80 } }).allowed, true);
  const denied = governance.admit({ executionId: 'e2', request: { memoryBytes: 30 } });
  assert.equal(denied.allowed, true);
  const deniedSame = governance.admit({ executionId: 'e1', request: { memoryBytes: 30 } });
  assert.equal(deniedSame.allowed, false);
  assert.equal(deniedSame.resource, 'memoryBytes');
});

test('bounds immutable decision history', () => {
  const governance = new RuntimeResourceGovernance({ maxHistory: 2 });
  governance.admit({ executionId: 'e1', request: { concurrency: 1 } });
  governance.release('e1', { concurrency: 1 });
  governance.admit({ executionId: 'e2', request: { concurrency: 1 } });
  assert.equal(governance.history().length, 2);
});
