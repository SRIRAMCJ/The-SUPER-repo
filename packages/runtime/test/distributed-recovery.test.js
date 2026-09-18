import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DistributedTransactionRecovery } from '../src/distributed-recovery.js';
import { RecoveryLeaseKernel } from '../src/recovery-lease.js';
import { RecoveryStateReplicator } from '../src/recovery-state-replication.js';

test('distributed recovery acquires fence, validates before and after recovery, and releases', async () => {
  const now = new Date('2026-09-18T05:00:00.000Z');
  const lease = new RecoveryLeaseKernel({ clock: () => now, leaseTtlMs: 1000 });
  let context;
  const coordinator = { scan: async () => [{ transactionId: 't1', status: 'active' }], transaction: { recover: async (_id, c) => { context = c; return { status: 'rolled_back' }; } } };
  const distributed = { execute: async ({ handler, fencingToken, signal }) => ({ executionId:'t1', nodeId:'n1', fencingToken, status:'succeeded', result: await handler({ signal, fencingToken }) }) };
  const r = new DistributedTransactionRecovery({ coordinator, lease, distributed, ownerId:'o1', nodeId:'n1', clock:()=>now });
  const out = await r.recover(); assert.equal(out.status,'succeeded'); assert.equal(context.fencingToken,1); assert.equal(lease.get('t1').state,'released');
});

test('second owner is fenced and transaction is not invoked', async () => {
  const lease = new RecoveryLeaseKernel({ leaseTtlMs:1000 }); lease.acquire({executionId:'t1',ownerId:'o2',nodeId:'n2'}); let calls=0;
  const coordinator={scan:async()=>[{transactionId:'t1',status:'active'}],transaction:{recover:async()=>{calls++;}}};
  const distributed={execute:async()=>{throw new Error('must not execute');}};
  const r=new DistributedTransactionRecovery({coordinator,lease,distributed,ownerId:'o1',nodeId:'n1'}); const out=await r.recover();
  assert.equal(calls,0); assert.equal(out.results[0].error.code,'RECOVERY_LEASE_HELD');
});

test('cancellation before scan is blocked and auditable', async()=>{ const c=new AbortController(); c.abort(); const r=new DistributedTransactionRecovery({coordinator:{scan:async()=>[]},lease:new RecoveryLeaseKernel(),distributed:{execute:async()=>{}},ownerId:'o',nodeId:'n'}); const out=await r.recover({signal:c.signal}); assert.equal(out.status,'blocked'); assert.equal(out.error.code,'DISTRIBUTED_RECOVERY_CANCELLED'); });

test('cancelled distributed result is not reported as success', async()=>{ const r=new DistributedTransactionRecovery({coordinator:{scan:async()=>[{transactionId:'t1',status:'active'}],transaction:{recover:async()=>{}}},lease:new RecoveryLeaseKernel(),distributed:{execute:async()=>({status:'cancelled',error:{code:'CANCELLED'}})},ownerId:'o',nodeId:'n'}); const out=await r.recover(); assert.equal(out.status,'blocked'); assert.equal(out.results[0].status,'cancelled'); });

test('distributed recovery durably replicates leased, recovering and terminal state', async()=>{ const dir=await mkdtemp(path.join(os.tmpdir(),'super-dist-recovery-')); try { const replicator=new RecoveryStateReplicator({filePath:path.join(dir,'state.jsonl'),idFactory:(p)=>p+'-id'}); const lease=new RecoveryLeaseKernel({idFactory:(p)=>p+'-lease'}); const coordinator={scan:async()=>[{transactionId:'t1',status:'active'}],transaction:{recover:async()=>({status:'rolled_back'})}}; const distributed={execute:async({handler,fencingToken,signal})=>({status:'succeeded',result:await handler({signal,fencingToken})})}; const r=new DistributedTransactionRecovery({coordinator,lease,distributed,stateReplicator:replicator,ownerId:'o1',nodeId:'n1',idFactory:(p)=>p+'-id'}); const out=await r.recover({reason:'node_restart'}); assert.equal(out.status,'succeeded'); assert.equal(replicator.get('t1').state,'succeeded'); assert.equal(replicator.get('t1').sequence,3); assert.equal(replicator.get('t1').reason,'node_restart'); } finally { await rm(dir,{recursive:true,force:true}); } });

test('history is bounded and immutable', async()=>{ const r=new DistributedTransactionRecovery({coordinator:{scan:async()=>[]},lease:new RecoveryLeaseKernel(),distributed:{execute:async()=>{}},ownerId:'o',nodeId:'n',maxHistory:2}); await r.recover(); await r.recover(); await r.recover(); assert.equal(r.history().length,2); assert.equal(Object.isFrozen(r.history()),true); });
