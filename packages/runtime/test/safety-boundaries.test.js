import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, CapabilityRegistry, ExecutionEngine, ToolRuntime } from '../src/index.js';
const manifest = { schemaVersion: '0.1.0', id: 'tool.safe', kind: 'tool', name: 'Safe', version: '1.0.0', status: 'stable', description: 'fixture', provenance: { sourceType: 'test' }, permissions: ['network'] };
test('policies deny asynchronous, malformed and throwing decisions', async () => {
  for (const policy of [async () => ({ allowed: false }), async () => { throw new Error('down'); }, () => undefined, () => ({}), () => { throw new Error('down'); }]) {
    const engine = new PolicyEngine({ policies: [policy] });
    assert.equal(engine.authorize({ risk: 'low' }).allowed, false);
  }
  await new Promise(setImmediate);
  assert.equal(new PolicyEngine({ policies: [() => true] }).authorize({ risk: 'low' }).allowed, true);
  assert.throws(() => new PolicyEngine({ policies: [{}] }), /functions/);
});
test('both execution paths stop async policy denials before side effects', async () => {
  let calls = 0; const registry = new CapabilityRegistry(); registry.register(manifest, () => calls++);
  const policy = new PolicyEngine({ policies: [async () => ({ allowed: false })] });
  assert.equal((await new ExecutionEngine({ registry, policy }).execute(manifest.id, {}, { network: true })).status, 'failed');
  assert.equal((await new ToolRuntime({ registry, policyEngine: policy }).execute(manifest.id, {}, { network: true })).status, 'failed');
  assert.equal(calls, 0);
});
test('registry isolates source, resolved and listed manifests and protects handlers', async () => {
  const source = structuredClone(manifest); const registry = new CapabilityRegistry(); const handler = () => 'trusted'; registry.register(source, handler);
  source.permissions.length = 0;
  registry.resolve(source.id).manifest.permissions.length = 0;
  registry.list()[0].permissions.length = 0;
  assert.throws(() => { registry.resolve(source.id).handler = () => 'replaced'; }, TypeError);
  assert.deepEqual(registry.require(source.id).manifest.permissions, ['network']);
  assert.equal(registry.require(source.id).handler, handler);
  const result = await new ExecutionEngine({ registry, policy: new PolicyEngine() }).execute(source.id);
  assert.equal(result.error.code, 'POLICY_DENIED');
});
test('execution engine does not invoke pre-cancelled handlers or handlers cancelled by a start listener', async () => {
  let calls = 0; const registry = new CapabilityRegistry(); registry.register(manifest, () => calls++);
  const controller = new AbortController(); controller.abort();
  const result = await new ExecutionEngine({ registry }).execute(manifest.id, {}, { signal: controller.signal });
  assert.equal(result.error.code, 'EXECUTION_CANCELLED'); assert.equal(calls, 0);
  const next = new AbortController();
  const engine = new ExecutionEngine({ registry, events: { emit() { next.abort(); } } });
  assert.equal((await engine.execute(manifest.id, {}, { signal: next.signal })).error.code, 'EXECUTION_CANCELLED'); assert.equal(calls, 0);
});
