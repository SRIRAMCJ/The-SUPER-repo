import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderRegistry, ModelRuntime, ModelExecutionKernel } from '../src/index.js';

test('registration captures provider metadata and handler against later mutation', async () => {
  const registry = new ModelProviderRegistry();
  const source = { id: 'local', status: 'stable', capabilities: ['chat'], async generate() { return { text: 'original' }; } };
  registry.register(source);
  source.id = 'replacement'; source.status = 'disabled'; source.capabilities.push('unsafe');
  source.generate = async () => ({ text: 'replaced' });
  assert.deepEqual(registry.list().map((item) => [item.id, item.status, item.capabilities]), [['local', 'stable', ['chat']]]);
  assert.equal((await registry.require('local').generate({})).text, 'original');
  assert.equal(registry.resolve('replacement'), null);
});

test('registry views cannot mutate provider status, capabilities or handler', async () => {
  const registry = new ModelProviderRegistry();
  registry.register({ id: 'local', status: 'stable', capabilities: ['chat'], async generate() { return { text: 'ok' }; } });
  const view = registry.resolve('local');
  view.status = 'disabled'; view.capabilities.push('other'); view.generate = async () => ({ text: 'spoofed' });
  const listed = registry.list()[0];
  listed.capabilities.push('another');
  assert.equal(registry.require('local').status, 'stable');
  assert.deepEqual(registry.require('local').capabilities, ['chat']);
  assert.equal((await registry.require('local').generate({})).text, 'ok');
  const kernel = new ModelExecutionKernel({ providers: registry, maxRetries: 0 });
  const outcome = await kernel.generate({ provider: 'local', model: 'm' });
  assert.equal(outcome.status, 'succeeded');
});

test('model response cannot overwrite runtime provenance or timing', async () => {
  const registry = new ModelProviderRegistry();
  registry.register({ id: 'real', async generate() { return { text: 'ok', provider: 'fake', model: 'fake', mode: 'embedding', latencyMs: -1 }; } });
  const result = await new ModelRuntime({ providers: registry }).generate({ provider: 'real', model: 'm', mode: 'chat' });
  assert.equal(result.provider, 'real'); assert.equal(result.model, 'm'); assert.equal(result.mode, 'chat');
  assert.ok(result.latencyMs >= 0); assert.equal(result.text, 'ok');
});

test('model runtime rejects malformed provider results', async () => {
  const registry = new ModelProviderRegistry();
  registry.register({ id: 'bad', async generate() { return null; } });
  await assert.rejects(new ModelRuntime({ providers: registry }).generate({ provider: 'bad', model: 'm' }), /return an object/);
});
