import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryStateReplicator } from '../src/recovery-state-replication.js';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'super-recovery-'));
  return { dir, filePath: path.join(dir, 'recovery.jsonl') };
}
function record(sequence, state = 'recovering', overrides = {}) {
  return { transactionId:'tx-1', sequence, state, ownerId:'owner-a', nodeId:'node-a', fencingToken:1, ...overrides };
}

test('durable replication survives restart and preserves latest transaction state', async () => {
  const f=await fixture();
  try {
    const a=new RecoveryStateReplicator({filePath:f.filePath, clock:()=>new Date('2026-09-18T05:00:00Z'), idFactory:(p)=>p+'-1'});
    await a.append(record(1,'detected')); await a.append(record(2,'leased'));
    const b=new RecoveryStateReplicator({filePath:f.filePath, idFactory:(p)=>p+'-2'});
    await b.load(); assert.equal(b.get('tx-1').state,'leased'); assert.equal(b.get('tx-1').sequence,2);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('duplicate replication is idempotent and conflicting equal sequence is rejected', async () => {
  const f=await fixture();
  try {
    const r=new RecoveryStateReplicator({filePath:f.filePath,idFactory:(p)=>p+'-1'});
    const x=record(1,'recovering',{recordId:'r1'}); await r.append(x);
    const duplicate=await r.apply(x); assert.equal(duplicate.duplicate,true);
    await assert.rejects(()=>r.apply({...x,recordId:'r2'}),e=>e.code==='RECOVERY_STATE_CONFLICT');
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('stale sequence and stale fencing token cannot overwrite newer state', async () => {
  const f=await fixture();
  try {
    const r=new RecoveryStateReplicator({filePath:f.filePath,idFactory:(p)=>p+'-1'});
    await r.append(record(2,'recovering',{fencingToken:3}));
    await assert.rejects(()=>r.apply(record(1,'leased',{fencingToken:3})),e=>e.code==='RECOVERY_STATE_STALE');
    await assert.rejects(()=>r.apply(record(3,'succeeded',{fencingToken:2})),e=>e.code==='RECOVERY_STATE_FENCED');
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('terminal state converges only through a newer sequence and equal-fence transition', async () => {
  const f=await fixture();
  try {
    const r=new RecoveryStateReplicator({filePath:f.filePath,idFactory:(p)=>p+'-1'});
    await r.append(record(1,'recovering'));
    await r.apply(record(2,'succeeded'));
    await assert.rejects(()=>r.apply(record(3,'recovering')),e=>e.code==='RECOVERY_STATE_STALE');
    assert.equal(r.get('tx-1').state,'succeeded');
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('malformed and invalid states are rejected and records are deeply immutable', async () => {
  const f=await fixture();
  try {
    const r=new RecoveryStateReplicator({filePath:f.filePath,idFactory:(p)=>p+'-1'});
    await assert.rejects(()=>r.append({transactionId:'tx',sequence:0,state:'detected',ownerId:'o',nodeId:'n',fencingToken:1}));
    await assert.rejects(()=>r.append({transactionId:'tx',sequence:1,state:'unknown',ownerId:'o',nodeId:'n',fencingToken:1}));
    await r.append({...record(1,'failed'),error:{code:'E',details:{nested:true}}});
    const s=r.snapshot(); assert.equal(Object.isFrozen(s),true); assert.equal(Object.isFrozen(s.records[0].error.details),true);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('replication history retention compacts durable records to bounded latest state', async () => {
  const f=await fixture();
  try {
    const r=new RecoveryStateReplicator({filePath:f.filePath,maxRecords:2,idFactory:(p)=>p+'-'+Math.random()});
    await r.append(record(1,'detected',{transactionId:'a'}));
    await r.append(record(1,'detected',{transactionId:'b'}));
    await r.append(record(2,'recovering',{transactionId:'a'}));
    const loaded=new RecoveryStateReplicator({filePath:f.filePath}); await loaded.load();
    assert.equal(loaded.list().length,2);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('cross-node sync converges a lagging replica and remains idempotent', async () => {
  const aDir=await fixture(), bDir=await fixture(), cDir=await fixture();
  try {
    const a=new RecoveryStateReplicator({filePath:aDir.filePath,idFactory:(p)=>p+'-a'});
    const b=new RecoveryStateReplicator({filePath:bDir.filePath,idFactory:(p)=>p+'-b'});
    const nodeC=new RecoveryStateReplicator({filePath:cDir.filePath,idFactory:(p)=>p+'-c'});
    await a.append(record(1,'detected',{recordId:'a1'}));
    await a.append(record(2,'recovering',{recordId:'a2'}));
    await b.append(record(1,'detected',{recordId:'a1'}));
    const first=await b.syncFrom(a);
    assert.equal(first.applied.length,1); assert.equal(b.get('tx-1').state,'recovering');
    const second=await b.syncFrom(a); assert.equal(second.applied.length,0); assert.equal(second.duplicates.length,2);
    await nodeC.syncFrom(b); assert.equal(nodeC.get('tx-1').state,'recovering'); assert.equal(nodeC.get('tx-1').sequence,2);
  } finally { await Promise.all([rm(aDir.dir,{recursive:true,force:true}),rm(bDir.dir,{recursive:true,force:true}),rm(cDir.dir,{recursive:true,force:true})]); }
});

test('cross-node sync rejects stale and fenced records without poisoning the replica', async () => {
  const f=await fixture();
  try {
    const r=new RecoveryStateReplicator({filePath:f.filePath,idFactory:(p)=>p+'-r'});
    await r.append(record(3,'succeeded',{fencingToken:5,recordId:'current'}));
    const source=new RecoveryStateReplicator({filePath:path.join(f.dir,'source.jsonl'),idFactory:(p)=>p+'-s'});
    await source.append(record(1,'recovering',{fencingToken:1,recordId:'old'}));
    const outcome=await r.syncFrom(source); assert.equal(outcome.applied.length,0); assert.equal(outcome.rejected.length,1);
    assert.equal(r.get('tx-1').state,'succeeded'); assert.equal(r.get('tx-1').fencingToken,5);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});
