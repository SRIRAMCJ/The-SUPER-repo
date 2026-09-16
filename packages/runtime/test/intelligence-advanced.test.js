import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderRegistry, ModelRuntime, ModelRouter, ReflectionEngine, createBasicOutputCritic } from '../src/index.js';

test('model provider registry executes through a provider contract', async () => {
  const providers = new ModelProviderRegistry();
  providers.register({
    id: 'provider/test',
    async generate(request) {
      return { text: `generated:${request.model}`, usage: { inputTokens: 2, outputTokens: 3 } };
    }
  });

  const runtime = new ModelRuntime({ providers });
  const result = await runtime.generate({ provider: 'provider/test', model: 'model-a', mode: 'chat', input: 'hello' });
  assert.equal(result.provider, 'provider/test');
  assert.equal(result.text, 'generated:model-a');
  assert.equal(result.usage.outputTokens, 3);
});

test('model router selects a compatible deterministic candidate', () => {
  const router = new ModelRouter({ models: [
    { id: 'model/small', provider: 'local', status: 'stable', capabilities: ['chat'], contextWindow: 8192, pricing: { inputPerMillionTokens: 0 } },
    { id: 'model/large', provider: 'cloud', status: 'stable', capabilities: ['chat', 'reasoning'], contextWindow: 128000, pricing: { inputPerMillionTokens: 2 } }
  ] });

  const route = router.route({ capability: 'reasoning', mode: 'chat', minimumContextWindow: 32000 });
  assert.equal(route.selection.modelId, 'model/large');
  assert.equal(route.candidates.length, 1);
});

test('reflection accepts valid output and rejects malformed failures', async () => {
  const reflection = new ReflectionEngine({ critics: [createBasicOutputCritic()] });
  const accepted = await reflection.evaluate({ result: { status: 'succeeded', output: {} } });
  assert.equal(accepted.status, 'accepted');

  const rejected = await reflection.evaluate({ result: { status: 'failed' } });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.summary.rejected, 1);
});

test('reflection supports custom critics', async () => {
  const reflection = new ReflectionEngine();
  reflection.register({
    id: 'critic/quality',
    async evaluate({ result }) {
      return result?.quality >= 0.8
        ? { status: 'accepted', reason: 'quality threshold met' }
        : { status: 'warning', reason: 'quality threshold not met', details: { threshold: 0.8 } };
    }
  });

  const result = await reflection.evaluate({ result: { status: 'succeeded', quality: 0.7 } });
  assert.equal(result.status, 'warning');
  assert.equal(result.evaluations[0].criticId, 'critic/quality');
});
