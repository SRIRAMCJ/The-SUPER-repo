import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, ExecutionEngine } from '../src/index.js';

const manifest = {
  schemaVersion:'0.1.0', id:'test/echo', kind:'tool', name:'Echo', version:'0.1.0', status:'stable',
  description:'Returns its input.', provenance:{sourceType:'native'}
};

test('registry registers and resolves executable capabilities', () => {
  const registry = new CapabilityRegistry();
  registry.register(manifest, async (input) => input);
  assert.equal(registry.require('test/echo').manifest.id, 'test/echo');
  assert.equal(registry.list('tool').length, 1);
});

test('execution engine emits lifecycle events and returns output', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  registry.register(manifest, async (input, ctx) => { ctx.emit({ phase:'running' }); return { echoed:input.value }; });
  const engine = new ExecutionEngine({ registry, events });
  const result = await engine.execute('test/echo', {value:'ok'});
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, {echoed:'ok'});
  assert.deepEqual(events.history().map((e) => e.type), ['execution.started','execution.progress','execution.verified','execution.completed']);
});

test('execution engine captures failures without losing execution identity', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  registry.register(manifest, async () => { throw Object.assign(new Error('boom'), { code:'TEST_FAILURE', retryable:true }); });
  const result = await new ExecutionEngine({registry, events}).execute('test/echo');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TEST_FAILURE');
  assert.match(result.executionId, /^exec_/);
  assert.equal(events.history({type:'execution.failed'}).length, 1);
});
