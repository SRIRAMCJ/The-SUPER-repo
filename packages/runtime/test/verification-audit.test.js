import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, ExecutionAudit, ExecutionEngine, MemoryStore, VerificationEngine } from '../src/index.js';

const manifest = { schemaVersion:'0.1.0', id:'test/verified', kind:'tool', name:'Verified', version:'0.1.0', status:'stable', description:'Verified tool', provenance:{sourceType:'native'} };

test('execution rejects output when verification fails', async () => {
  const registry = new CapabilityRegistry();
  const verifier = new VerificationEngine({ checks:[({output}) => output.ok === true] });
  const events = new EventBus();
  registry.register(manifest, async () => ({ok:false}));
  const result = await new ExecutionEngine({registry, events, verifier}).execute(manifest.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'VERIFICATION_FAILED');
  assert.equal(events.history({type:'execution.verified'}).length, 1);
  assert.equal(events.history({type:'execution.completed'}).length, 0);
});

test('audit reconstructs execution lifecycle and memory stores records', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  const audit = new ExecutionAudit({events});
  const memory = new MemoryStore();
  registry.register(manifest, async () => ({ok:true}));
  const result = await new ExecutionEngine({registry, events}).execute(manifest.id);
  const record = audit.get(result.executionId);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.capabilityId, manifest.id);
  assert.equal(record.events.at(-1).type, 'execution.completed');
  memory.append(record);
  assert.equal(memory.size(), 1);
  assert.equal(memory.query((item) => item.status === 'succeeded').length, 1);
  audit.close();
});
