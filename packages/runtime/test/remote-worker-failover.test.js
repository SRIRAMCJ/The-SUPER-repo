import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';
import { RemoteWorkerScheduler } from '../src/remote-worker-scheduler.js';
import { RemoteWorkerFailoverController } from '../src/remote-worker-failover.js';

test('heartbeat-driven failover creates a replacement assignment and preserves execution identity',async()=>{const registry=new RemoteWorkerRegistry();registry.register({workerId:'a',capabilities:['runtime.execute']});registry.register({workerId:'b',capabilities:['runtime.execute']});const leases=new RemoteWorkerLeaseManager();const scheduler=new RemoteWorkerScheduler({registry,leases});const first=scheduler.schedule({executionId:'e-heartbeat',capabilityId:'runtime.execute'});const controller=new RemoteWorkerFailoverController({scheduler,capabilityResolver:async()=> 'runtime.execute'});const result=await controller.handleExecutionLost({executionId:'e-heartbeat',workerId:first.workerId});assert.equal(result.state,'scheduled');assert.equal(result.executionId,'e-heartbeat');assert.equal(result.workerId,'b');assert.equal(leases.get(first.leaseId).status,'fenced');});
