import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';
import { RemoteWorkerScheduler } from '../src/remote-worker-scheduler.js';

test('schedules execution onto a capable healthy worker',()=>{const r=new RemoteWorkerRegistry();r.register({workerId:'w1',capabilities:['runtime.execute']});const l=new RemoteWorkerLeaseManager();const s=new RemoteWorkerScheduler({registry:r,leases:l});const x=s.schedule({executionId:'e1',capabilityId:'runtime.execute'});assert.equal(x.state,'scheduled');assert.equal(x.workerId,'w1');});
test('fails closed when no capable worker exists',()=>{const r=new RemoteWorkerRegistry();const s=new RemoteWorkerScheduler({registry:r,leases:new RemoteWorkerLeaseManager()});const x=s.schedule({executionId:'e1',capabilityId:'runtime.execute'});assert.equal(x.state,'unavailable');assert.equal(x.retryable,true);});
test('surfaces active lease conflict as retryable scheduling conflict',()=>{const r=new RemoteWorkerRegistry();r.register({workerId:'w1',capabilities:['runtime.execute']});const l=new RemoteWorkerLeaseManager();const s=new RemoteWorkerScheduler({registry:r,leases:l});assert.equal(s.schedule({executionId:'e1',capabilityId:'runtime.execute'}).state,'scheduled');const x=s.schedule({executionId:'e1',capabilityId:'runtime.execute'});assert.equal(x.state,'conflict');assert.equal(x.retryable,true);});


test('reassign fences the previous lease and schedules a replacement worker',()=>{const r=new RemoteWorkerRegistry();r.register({workerId:'a',capabilities:['runtime.execute']});r.register({workerId:'b',capabilities:['runtime.execute']});const l=new RemoteWorkerLeaseManager();const s=new RemoteWorkerScheduler({registry:r,leases:l});const first=s.schedule({executionId:'e-reassign',capabilityId:'runtime.execute'});const next=s.reassign({executionId:'e-reassign',capabilityId:'runtime.execute',failedWorkerId:first.workerId});assert.equal(first.workerId,'a');assert.equal(next.state,'scheduled');assert.equal(next.workerId,'b');assert.equal(l.get(first.leaseId).status,'fenced');assert.notEqual(next.fencingToken,first.fencingToken);});
