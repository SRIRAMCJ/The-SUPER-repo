import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableObservabilityCheckpointStore, ObservabilityCheckpointAuthority } from '../src/index.js';

test('durable checkpoint store survives restart and authority restores checkpoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-checkpoint-'));
  const file = path.join(dir, 'checkpoints.jsonl');
  const store = new DurableObservabilityCheckpointStore({ filePath:file });
  const first = new ObservabilityCheckpointAuthority({ store, idFactory:()=> 'id-1' });
  assert.equal(first.commit({nodeId:'n1',sourceNodeId:'a',sourceSequence:3,eventSequence:30,fencingToken:4}).state,'committed');
  const restartedStore = new DurableObservabilityCheckpointStore({ filePath:file });
  const second = new ObservabilityCheckpointAuthority({ store:restartedStore, idFactory:()=> 'id-2' });
  assert.equal(second.get('a').sourceSequence,3);
  assert.equal(second.commit({nodeId:'n2',sourceNodeId:'a',sourceSequence:2,eventSequence:20,fencingToken:4}).state,'stale');
});

test('durable checkpoint store rejects conflicting concurrent writer state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-checkpoint-'));
  const file = path.join(dir, 'checkpoints.jsonl');
  const a = new DurableObservabilityCheckpointStore({ filePath:file});
  const b = new DurableObservabilityCheckpointStore({ filePath:file});
  assert.equal(a.append({checkpointId:'1',sourceNodeId:'a',sourceSequence:1,eventSequence:1,fencingToken:1}).state,'committed');
  assert.equal(b.append({checkpointId:'2',sourceNodeId:'a',sourceSequence:1,eventSequence:1,fencingToken:1}).state,'duplicate');
  assert.equal(b.append({checkpointId:'3',sourceNodeId:'a',sourceSequence:1,eventSequence:0,fencingToken:1}).state,'conflict');
});
