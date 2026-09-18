import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryLeaseKernel } from '../src/recovery-lease.js';

function setup() { let now = new Date('2026-09-18T05:00:00.000Z'); return { clock: () => now, advance(ms) { now = new Date(now.getTime() + ms); } }; }

test('acquires lease with monotonic fencing token and is idempotent for same owner', () => {
  const t = setup(); const k = new RecoveryLeaseKernel({ clock: t.clock, idFactory: p => p + '-1', leaseTtlMs: 1000 });
  const a = k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' });
  assert.equal(a.fencingToken, 1); assert.deepEqual(k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' }), a);
});

test('prevents concurrent owners and exposes fencing details', () => {
  const k = new RecoveryLeaseKernel({ leaseTtlMs: 1000 });
  const a = k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' });
  assert.throws(() => k.acquire({ executionId: 'e1', ownerId: 'o2', nodeId: 'n2' }), e => e.code === 'RECOVERY_LEASE_HELD' && e.details.fencingToken === a.fencingToken);
});

test('expired lease can be reclaimed and fencing token advances', () => {
  const t = setup(); const k = new RecoveryLeaseKernel({ clock: t.clock, leaseTtlMs: 1000 });
  const a = k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' }); t.advance(1001);
  assert.equal(k.get('e1').state, 'expired');
  const b = k.acquire({ executionId: 'e1', ownerId: 'o2', nodeId: 'n2' }); assert.equal(b.fencingToken, a.fencingToken + 1);
});

test('stale owner cannot renew or release after fencing changes', () => {
  const t = setup(); const k = new RecoveryLeaseKernel({ clock: t.clock, leaseTtlMs: 1000 });
  const a = k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' }); t.advance(1001);
  const b = k.acquire({ executionId: 'e1', ownerId: 'o2', nodeId: 'n2' });
  assert.throws(() => k.renew({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: a.fencingToken }), e => e.code === 'RECOVERY_LEASE_STALE_FENCING_TOKEN' || e.code === 'RECOVERY_LEASE_NOT_OWNER');
  assert.throws(() => k.release({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: a.fencingToken }), e => e.code === 'RECOVERY_LEASE_STALE_FENCING_TOKEN' || e.code === 'RECOVERY_LEASE_NOT_OWNER');
  assert.equal(k.validate({ executionId: 'e1', ownerId: 'o2', nodeId: 'n2', fencingToken: b.fencingToken }).fencingToken, b.fencingToken);
});

test('renew extends lease, release is terminal, cancellation is deterministic', () => {
  const t = setup(); const k = new RecoveryLeaseKernel({ clock: t.clock, leaseTtlMs: 1000 });
  const a = k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' }); t.advance(500);
  const b = k.renew({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: a.fencingToken });
  assert.ok(Date.parse(b.expiresAt) > Date.parse(a.expiresAt)); const r = k.release({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: b.fencingToken });
  assert.equal(r.state, 'released');
  assert.throws(() => k.validate({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: b.fencingToken }), e => e.code === 'RECOVERY_LEASE_EXPIRED');
  const c = new AbortController(); c.abort(); assert.throws(() => k.acquire({ executionId: 'e2', ownerId: 'o1', nodeId: 'n1', signal: c.signal }), e => e.code === 'RECOVERY_LEASE_CANCELLED');
});

test('history and snapshots are bounded and immutable', () => {
  const k = new RecoveryLeaseKernel({ maxHistory: 2 });
  k.acquire({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1' }); k.renew({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: 1 }); k.release({ executionId: 'e1', ownerId: 'o1', nodeId: 'n1', fencingToken: 1 });
  assert.equal(k.history().length, 2); assert.equal(Object.isFrozen(k.history()), true); assert.equal(Object.isFrozen(k.snapshot()), true);
});
