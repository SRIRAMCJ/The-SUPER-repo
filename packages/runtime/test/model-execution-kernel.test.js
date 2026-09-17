import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelExecutionKernel, ModelProviderRegistry, ModelRouter } from '../src/index.js';

const NOW = new Date('2026-09-17T13:00:00.000Z');

function setup(provider) {
  const providers = new ModelProviderRegistry();
  providers.register(provider);
  const router = new ModelRouter({ models: [{ id: 'model-a', provider: provider.id, status: 'stable', capabilities: ['chat', 'reasoning'], contextWindow: 32000 }] });
  const events = { values: [], emit(event) { this.values.push(event); } };
  const kernel = new ModelExecutionKernel({ providers, router, events, clock: () => new Date(NOW), idFactory: () => 'model-exec-001' });
  return { kernel, events };
}

test('routes and executes a model request with correlation metadata', async () => {
  const { kernel, events } = setup({ id: 'provider-a', status: 'stable', capabilities: ['chat'], async generate(request) { return { text: `hello:${request.model}` }; } });
  const result = await kernel.generate({ mode: 'chat', capability: 'reasoning' }, { correlationId: 'corr-model' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.provider, 'provider-a');
  assert.equal(result.model, 'model-a');
  assert.equal(result.correlationId, 'corr-model');
  assert.equal(result.attempts.length, 1);
  assert.ok(events.values.some((event) => event.type === 'model.execution.completed'));
});

test('retries bounded retryable provider failures', async () => {
  let calls = 0;
  const { kernel } = setup({ id: 'provider-a', status: 'stable', async generate() { calls += 1; if (calls < 3) throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true }); return { text: 'ok' }; } });
  const result = await kernel.generate({ provider: 'provider-a', model: 'model-a' });
  assert.equal(result.status, 'succeeded');
  assert.equal(calls, 3);
  assert.equal(result.attempts.length, 3);
});

test('does not retry non-retryable failures', async () => {
  let calls = 0;
  const { kernel } = setup({ id: 'provider-a', status: 'stable', async generate() { calls += 1; throw Object.assign(new Error('bad request'), { code: 'BAD_REQUEST', retryable: false }); } });
  const result = await kernel.generate({ provider: 'provider-a', model: 'model-a' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'BAD_REQUEST');
  assert.equal(calls, 1);
});

test('enforces provider availability and model policy', async () => {
  const providers = new ModelProviderRegistry();
  providers.register({ id: 'disabled', status: 'disabled', async generate() { throw new Error('must not execute'); } });
  const kernel = new ModelExecutionKernel({ providers, clock: () => new Date(NOW), idFactory: () => 'model-disabled' });
  const result = await kernel.generate({ provider: 'disabled', model: 'model-a' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MODEL_PROVIDER_UNAVAILABLE');

  const active = new ModelProviderRegistry();
  active.register({ id: 'provider-a', status: 'stable', async generate() { return { text: 'secret' }; } });
  const denied = new ModelExecutionKernel({ providers: active, policy: { async authorize() { return { allowed: false, reason: 'approval required' }; } }, clock: () => new Date(NOW), idFactory: () => 'model-policy' });
  const policyResult = await denied.generate({ provider: 'provider-a', model: 'model-a' });
  assert.equal(policyResult.status, 'rejected');
  assert.equal(policyResult.error.code, 'MODEL_POLICY_DENIED');
});

test('fails deterministically when routing finds no compatible provider', async () => {
  const providers = new ModelProviderRegistry();
  providers.register({ id: 'provider-a', status: 'stable', async generate() { return { text: 'unused' }; } });
  const router = new ModelRouter({ models: [{ id: 'model-a', provider: 'provider-a', status: 'stable', capabilities: ['embedding'] }] });
  const kernel = new ModelExecutionKernel({ providers, router, clock: () => new Date(NOW), idFactory: () => 'model-route' });
  const result = await kernel.generate({ mode: 'chat' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MODEL_ROUTE_NOT_FOUND');
});
