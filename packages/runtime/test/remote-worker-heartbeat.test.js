import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerHeartbeatMonitor } from '../src/remote-worker-heartbeat.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';

test('marks workers unhealthy after heartbeat timeout',()=>{let now=Date.parse('2026-09-20T00:00:00Z');const r=new RemoteWorkerRegistry({clock:()=>new Date(now)});r.register({workerId:'w1',capabilities:['runtime.execute']});now+=31_000;const m=new RemoteWorkerHeartbeatMonitor({registry:r,clock:()=>now,timeoutMs:30_000});assert.equal(m.sweep().changed.length,1);assert.equal(r.get('w1').state,'unhealthy');});
test('does not mark fresh workers unhealthy',()=>{let now=Date.parse('2026-09-20T00:00:00Z');const r=new RemoteWorkerRegistry({clock:()=>new Date(now)});r.register({workerId:'w1'});now+=10_000;const m=new RemoteWorkerHeartbeatMonitor({registry:r,clock:()=>now});assert.equal(m.sweep().changed.length,0);});
test('reports worker health counts',()=>{const r=new RemoteWorkerRegistry();r.register({workerId:'a'});r.register({workerId:'b'});r.markUnhealthy('b');const m=new RemoteWorkerHeartbeatMonitor({registry:r});assert.deepEqual(m.status(),{schemaVersion:'0.1.0',total:2,healthy:1,unhealthy:1});});


test('heartbeat loss fences active worker executions and emits recovery signal',async()=>{let now=Date.parse('2026-09-20T00:00:00Z');const r=new RemoteWorkerRegistry({clock:()=>new Date(now)});r.register({workerId:'w1',capabilities:['runtime.execute']});const l=new RemoteWorkerLeaseManager({clock:()=>now,ttlMs:60_000});const a=l.acquire({executionId:'exec-lost',workerId:'w1'});const lost=[];now+=31_000;const m=new RemoteWorkerHeartbeatMonitor({registry:r,leaseManager:l,clock:()=>now,timeoutMs:30_000,onExecutionLost:async event=>lost.push(event)});const result=await m.sweep();assert.equal(result.lost.length,1);assert.equal(result.lost[0].executionId,'exec-lost');assert.equal(l.get(a.lease.leaseId).status,'fenced');assert.equal(lost[0].leaseId,a.lease.leaseId);});
