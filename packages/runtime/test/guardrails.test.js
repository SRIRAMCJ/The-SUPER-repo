import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, ExecutionEngine, PolicyEngine } from '../src/index.js';

const base = (id, extra = {}) => ({
  schemaVersion:'0.1.0', id, kind:'tool', name:id, version:'0.1.0', status:'stable', description:id, provenance:{sourceType:'native'}, ...extra
});

test('execution boundary enforces policy for direct capability execution', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  let invoked = false;
  registry.register(base('guard/critical', { risk:'critical' }), async () => { invoked = true; });
  const result = await new ExecutionEngine({ registry, events, policy:new PolicyEngine() }).execute('guard/critical');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'POLICY_DENIED');
  assert.equal(invoked, false);
  assert.equal(events.history({type:'execution.denied'}).length, 1);
});

test('execution boundary times out and aborts a long-running handler', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  let aborted = false;
  registry.register(base('guard/slow', { timeoutSeconds:1 }), async (_input, { signal }) => {
    await new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once:true });
    });
    return { stopped:true };
  });
  const result = await new ExecutionEngine({ registry, events }).execute('guard/slow');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXECUTION_TIMEOUT');
  assert.equal(aborted, true);
  assert.equal(events.history({type:'execution.failed'}).length, 1);
});
