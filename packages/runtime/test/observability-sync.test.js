import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilitySyncCoordinator, ObservabilityCheckpointAuthority } from '../src/index.js';

function setup() {
  const source = {
    events: [
      { id: 'e1', type: 'execution.started', sourceNodeId: 'node-a', sourceSequence: 1, fencingToken: 2 },
      { id: 'e2', type: 'execution.completed', sourceNodeId: 'node-a', sourceSequence: 2, fencingToken: 2 },
      { id: 'b1', type: 'execution.started', sourceNodeId: 'node-b', sourceSequence: 8, fencingToken: 1 },
    ],
    async replay() { return structuredClone(this.events); },
    snapshot() { return { type: 'source', retainedEvents: this.events.length }; },
  };
  const imported = [];
  const transport = {
    ingest(events) { imported.push(...events); return events.map((event) => ({ state: 'published', event })); },
    history() { return imported; },
    snapshot() { return { type: 'transport', retainedEvents: imported.length }; },
  };
  return { source, transport, imported };
}

test('observability sync imports events after a source cursor and detects gaps', async () => {
  const { source, transport, imported } = setup();
  const coordinator = new ObservabilitySyncCoordinator({ store: source, transport, idFactory: () => 'sync-1' });
  const result = await coordinator.syncFrom({ sourceNodeId: 'node-a', afterSourceSequence: 0, limit: 10 });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.imported, 2);
  assert.deepEqual(imported.map((event) => event.sourceSequence), [1, 2]);
  const partial = await coordinator.syncFrom({ sourceNodeId: 'node-b', afterSourceSequence: 2, limit: 10 });
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.gap, { from: 3, to: 7 });
});

test('observability sync is idempotently deduplicated while concurrent requests share work', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const source = {
    async replay() { await gate; return [{ id: 'e1', type: 'a', sourceNodeId: 'node-a', sourceSequence: 1, fencingToken: 1 }]; },
    snapshot() { return {}; },
  };
  const transport = {
    ingest(events) { return events.map((event) => ({ state: 'published', event })); },
    history() { return []; },
    snapshot() { return {}; },
  };
  const coordinator = new ObservabilitySyncCoordinator({ store: source, transport, idFactory: () => 'sync-2' });
  const first = coordinator.syncFrom({ sourceNodeId: 'node-a', afterSourceSequence: 0 });
  const second = coordinator.syncFrom({ sourceNodeId: 'node-a', afterSourceSequence: 0 });
  release();
  assert.strictEqual(await first, await second);
});

test('observability sync cancellation and immutable audit history are explicit', async () => {
  const { source, transport } = setup();
  const controller = new AbortController();
  controller.abort();
  const coordinator = new ObservabilitySyncCoordinator({ store: source, transport, idFactory: () => 'sync-3' });
  const result = await coordinator.syncFrom({ sourceNodeId: 'node-a', signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  const history = coordinator.history();
  assert.throws(() => { history.push({}); }, TypeError);
  assert.equal(coordinator.status().state, 'idle');
});

test('observability sync resumes from checkpoint and advances it only after a complete batch', async () => {
  const source = {
    async replaySource({ sourceNodeId, afterSourceSequence, limit }) {
      return [{ id:'e4', type:'execution.completed', sourceNodeId, sourceSequence:4, sequence:44, fencingToken:7 }].filter(e => e.sourceSequence > afterSourceSequence).slice(0,limit);
    },
    snapshot() { return { retainedEvents:1 }; },
  };
  const imported = [];
  const transport = {
    ingest(events) { imported.push(...events); return events.map(event => ({state:'published',event})); },
    history() { return imported; },
    snapshot() { return {nodeId:'sync-node',retainedEvents:imported.length}; },
  };
  const checkpoint = new ObservabilityCheckpointAuthority({ idFactory: (()=>{let i=0; return ()=>String(++i);})() });
  checkpoint.commit({nodeId:'sync-node',sourceNodeId:'source-a',sourceSequence:3,eventSequence:33,fencingToken:7});
  const coordinator = new ObservabilitySyncCoordinator({store:source,transport,checkpoint,idFactory:()=> 'resume-1'});
  const result = await coordinator.syncFrom({sourceNodeId:'source-a',limit:10});
  assert.equal(result.state,'succeeded');
  assert.equal(result.checkpoint,'committed');
  assert.equal(checkpoint.get('source-a').sourceSequence,4);
  assert.equal(imported.length,1);
});


test('observability sync binds checkpoints to a verified durable source range digest', async () => {
  const source = {
    async replaySource({ sourceNodeId, afterSourceSequence, limit }) {
      return [{ id:'e4', type:'execution.completed', sourceNodeId, sourceSequence:4, sequence:44, fencingToken:7 }].filter(e => e.sourceSequence > afterSourceSequence).slice(0, limit);
    },
    async digestSourceRange({ sourceNodeId, fromSourceSequence, toSourceSequence }) {
      assert.equal(sourceNodeId, 'source-a');
      assert.equal(fromSourceSequence, 4);
      assert.equal(toSourceSequence, 4);
      return { valid:true, digest:'a'.repeat(64), fromSourceSequence, toSourceSequence };
    },
    snapshot() { return { retainedEvents:1 }; },
  };
  const transport = {
    ingest(events) { return events.map(event => ({state:'published',event})); },
    history() { return []; },
    snapshot() { return {nodeId:'sync-node'}; },
  };
  const checkpoint = new ObservabilityCheckpointAuthority({ idFactory:(()=>{let i=0;return()=>String(++i);})() });
  checkpoint.commit({nodeId:'sync-node',sourceNodeId:'source-a',sourceSequence:3,eventSequence:33,fencingToken:7});
  const coordinator = new ObservabilitySyncCoordinator({store:source,transport,checkpoint,idFactory:()=> 'integrity-sync'});
  const result = await coordinator.syncFrom({sourceNodeId:'source-a',limit:10});
  assert.equal(result.state,'succeeded');
  assert.equal(result.integrity.digest,'a'.repeat(64));
  const saved = checkpoint.get('source-a');
  assert.equal(saved.digest,'a'.repeat(64));
  assert.equal(saved.digestFromSourceSequence,4);
  assert.equal(saved.digestToSourceSequence,4);
});
