import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveAgentRuntime, EventBus, ModelProviderRegistry, ModelRouter, ModelRuntime, ReflectionEngine, createBasicOutputCritic } from '../src/index.js';

test('adaptive runtime routes a model, injects its result, executes an agent, and reflects', async () => {
  const events = new EventBus();
  const providers = new ModelProviderRegistry();
  providers.register({ id: 'provider/test', async generate() { return { text: 'model-context' }; } });
  const modelRuntime = new ModelRuntime({ providers });
  const modelRouter = new ModelRouter({ models: [{ id: 'model/test', provider: 'provider/test', status: 'stable', capabilities: ['chat', 'reasoning'], contextWindow: 16000 }] });

  const agentRuntime = {
    plan() { return { selection: { capabilityId: 'agent/test' } }; },
    async executeRequest(_request, _input, context) {
      return { status: 'succeeded', output: { seen: context.model.text } };
    }
  };
  const reflection = new ReflectionEngine({ critics: [createBasicOutputCritic()] });
  const runtime = new AdaptiveAgentRuntime({ agentRuntime, modelRouter, modelRuntime, reflection, events });

  const result = await runtime.execute('analyze repository', { path: '.' }, {}, {
    modelTask: { capability: 'reasoning', mode: 'chat', minimumContextWindow: 8000 },
    generate: true
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.route.selection.modelId, 'model/test');
  assert.equal(result.model.text, 'model-context');
  assert.equal(result.result.output.seen, 'model-context');
  assert.equal(result.reflection.status, 'accepted');
  assert.equal(events.history().at(-1).type, 'adaptive.completed');
});

test('adaptive runtime returns a structured failure when no model matches', async () => {
  const runtime = new AdaptiveAgentRuntime({
    agentRuntime: { plan: () => ({ selection: { capabilityId: 'agent/test' } }) },
    modelRouter: new ModelRouter({ models: [] })
  });

  const result = await runtime.execute('test', {}, {}, { modelTask: { capability: 'reasoning' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NO_MODEL_MATCH');
  assert.ok(result.route);
});

test('adaptive runtime converts reflection rejection into a failed result', async () => {
  const agentRuntime = {
    plan: () => ({ selection: { capabilityId: 'agent/test' } }),
    executeRequest: async () => ({ status: 'succeeded' })
  };
  const reflection = new ReflectionEngine({ critics: [{ id: 'critic/reject', async evaluate() { return { status: 'rejected', reason: 'quality gate failed' }; } }] });
  const runtime = new AdaptiveAgentRuntime({ agentRuntime, reflection });

  const result = await runtime.execute('test');
  assert.equal(result.status, 'failed');
  assert.equal(result.reflection.status, 'rejected');
});
