import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryHandoffKernel } from '../src/recovery-handoff.js';
import { RecoveryLeaseKernel } from '../src/recovery-lease.js';

test('handoff follows offer, accept, execute and fenced completion lifecycle', async () => {
  const now=new Date('2026-09-18T06:00:00Z');
  const lease=new RecoveryLeaseKernel({clock:()=>now,leaseTtlMs:5000});
  const k=new RecoveryHandoffKernel({lease,clock:()=>now,idFactory:(p)=>p+'-1'});
  const offered=k.offer({transactionId:'tx1',sourceNodeId:'node-a',targetNodeId:'node-b'});
  const accepted=await k.accept({transactionId:'tx1',targetNodeId:'node-b',ownerId:'owner-b'});
  assert.equal(accepted.handoff.state,'accepted'); assert.equal(accepted.handoff.fencingToken,1);
  const executing=k.beginExecution({transactionId:'tx1',targetNodeId:'node-b',fencingToken:1});
  assert.equal(executing.state,'executing');
  const done=k.complete({transactionId:'tx1',targetNodeId:'node-b',fencingToken:1,status:'succeeded',result:{ok:true}});
  assert.equal(done.state,'completed'); assert.equal(done.completionStatus,'succeeded'); assert.equal(offered.state,'offered');
});

test('wrong target and stale fencing token cannot execute or complete a handoff', async () => {
  const lease=new RecoveryLeaseKernel({leaseTtlMs:5000}); const k=new RecoveryHandoffKernel({lease});
  k.offer({transactionId:'tx2',sourceNodeId:'a',targetNodeId:'b'}); const accepted=await k.accept({transactionId:'tx2',targetNodeId:'b',ownerId:'o'});
  assert.throws(()=>k.beginExecution({transactionId:'tx2',targetNodeId:'c',fencingToken:accepted.handoff.fencingToken}),e=>e.code==='RECOVERY_HANDOFF_TARGET_MISMATCH');
  assert.throws(()=>k.beginExecution({transactionId:'tx2',targetNodeId:'b',fencingToken:accepted.handoff.fencingToken+1}),e=>e.code==='RECOVERY_HANDOFF_STALE_FENCE');
});

test('second active handoff is rejected and terminal handoff cannot be reused', async () => {
  const lease=new RecoveryLeaseKernel({leaseTtlMs:5000}); const k=new RecoveryHandoffKernel({lease});
  k.offer({transactionId:'tx3',sourceNodeId:'a',targetNodeId:'b'}); assert.throws(()=>k.offer({transactionId:'tx3',sourceNodeId:'a',targetNodeId:'c'}),e=>e.code==='RECOVERY_HANDOFF_IN_PROGRESS');
  const accepted=await k.accept({transactionId:'tx3',targetNodeId:'b',ownerId:'o'}); k.beginExecution({transactionId:'tx3',targetNodeId:'b',fencingToken:accepted.handoff.fencingToken}); k.complete({transactionId:'tx3',targetNodeId:'b',fencingToken:1});
  assert.throws(()=>k.beginExecution({transactionId:'tx3',targetNodeId:'b',fencingToken:1}),e=>e.code==='RECOVERY_HANDOFF_NOT_ACCEPTED');
});

test('offer expires deterministically before acceptance', async () => {
  let now=new Date('2026-09-18T06:00:00Z'); const lease=new RecoveryLeaseKernel({clock:()=>now});
  const k=new RecoveryHandoffKernel({lease,clock:()=>now,handoffTtlMs:100});
  k.offer({transactionId:'tx4',sourceNodeId:'a',targetNodeId:'b'}); now=new Date('2026-09-18T06:00:00.101Z');
  assert.equal(k.get('tx4').state,'expired'); assert.throws(()=>k.accept({transactionId:'tx4',targetNodeId:'b',ownerId:'o'}),e=>e.code==='RECOVERY_HANDOFF_NOT_OFFERED');
});

test('cancellation is fenced and auditable', async () => {
  const lease=new RecoveryLeaseKernel({leaseTtlMs:5000}); const k=new RecoveryHandoffKernel({lease});
  k.offer({transactionId:'tx5',sourceNodeId:'a',targetNodeId:'b'}); const accepted=await k.accept({transactionId:'tx5',targetNodeId:'b',ownerId:'o'});
  const cancelled=k.cancel({transactionId:'tx5',targetNodeId:'b',fencingToken:accepted.handoff.fencingToken,reason:'operator_abort'});
  assert.equal(cancelled.state,'cancelled'); assert.equal(cancelled.cancelReason,'operator_abort'); assert.equal(k.history().length,3);
});

test('history and snapshots are deeply immutable and bounded', () => {
  const lease=new RecoveryLeaseKernel({leaseTtlMs:5000}); const k=new RecoveryHandoffKernel({lease,maxHistory:2});
  k.offer({transactionId:'a',sourceNodeId:'a',targetNodeId:'b'}); k.offer({transactionId:'b',sourceNodeId:'a',targetNodeId:'c'}); const h=k.history();
  assert.equal(h.length,2); assert.equal(Object.isFrozen(h),true); assert.equal(Object.isFrozen(h[0].data),true); assert.equal(Object.isFrozen(k.snapshot()),true);
});
