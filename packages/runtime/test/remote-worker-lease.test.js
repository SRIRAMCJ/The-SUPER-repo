import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';

test('acquires and renews worker lease',()=>{let now=1000;const m=new RemoteWorkerLeaseManager({clock:()=>now,ttlMs:100});const a=m.acquire({executionId:'e1',workerId:'w1'});assert.equal(a.state,'acquired');now=1050;const r=m.renew(a.lease.leaseId);assert.equal(r.lease.expiresAt,1150);});
test('expires leases deterministically',()=>{let now=0;const m=new RemoteWorkerLeaseManager({clock:()=>now,ttlMs:10});const a=m.acquire({executionId:'e1',workerId:'w1'});now=11;assert.equal(m.expire().expired,1);assert.equal(m.get(a.lease.leaseId).status,'expired');});
test('prevents duplicate active lease for execution',()=>{const m=new RemoteWorkerLeaseManager({ttlMs:100});m.acquire({executionId:'e1',workerId:'w1'});const r=m.acquire({executionId:'e1',workerId:'w2'});assert.equal(r.code,'LEASE_ALREADY_HELD');});
test('release is idempotently terminal',()=>{const m=new RemoteWorkerLeaseManager();const a=m.acquire({executionId:'e1',workerId:'w1'});assert.equal(m.release(a.lease.leaseId).state,'released');assert.equal(m.release(a.lease.leaseId).state,'already_terminal');});
test('snapshots are isolated',()=>{const m=new RemoteWorkerLeaseManager();const a=m.acquire({executionId:'e1',workerId:'w1'});const copy=m.get(a.lease.leaseId);copy.status='bad';assert.equal(m.get(a.lease.leaseId).status,'active');});
