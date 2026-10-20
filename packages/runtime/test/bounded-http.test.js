import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BoundedHttpTransport } from '../src/bounded-http.js';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';

test('tool manifest request budget counts actual dispatches and ignores caller override', async () => {
  let calls = 0;
  const transport = new BoundedHttpTransport({ allowedOrigins: ['https://example.test'], fetchImpl: async (_, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response('ok');
  } });
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'tool/network', kind: 'tool', name: 'Network', version: '1.0.0', status: 'stable', description: 'test',
    provenance: { sourceType: 'test' }, resourceRequest: { networkRequests: 2 } }, async (_, { network }) => {
    await Promise.all([network.request('https://example.test/one'), network.request('https://example.test/two')]);
    await assert.rejects(network.request('https://example.test/three'), { code: 'NETWORK_REQUEST_LIMIT' });
    return network.used;
  });
  const runtime = new ToolRuntime({ registry, networkTransport: transport });
  const result = await runtime.execute('tool/network', {}, { resourceRequest: { networkRequests: 100 } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 2);
  assert.equal(calls, 2);
});

test('unallowed origins, redirects and large responses do not escape the adapter', async () => {
  let calls = 0;
  const transport = new BoundedHttpTransport({ allowedOrigins: ['https://example.test'], maxResponseBytes: 4,
    fetchImpl: async (_, options) => { calls++; return calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }) : new Response('too large'); } });
  const session = transport.session({ maxRequests: 2 });
  await assert.rejects(session.request('https://elsewhere.test/'), { code: 'NETWORK_ORIGIN_DENIED' });
  assert.equal(calls, 0);
  await assert.rejects(session.request('https://example.test/redirect'), { code: 'NETWORK_REDIRECT_DENIED' });
  await assert.rejects(session.request('https://example.test/large'), { code: 'NETWORK_RESPONSE_TOO_LARGE' });
  assert.equal(session.used, 2);
});

test('local HTTP adapter cancels an in-flight request', async () => {
  const instance = createServer(() => {});
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${instance.address().port}`;
    const controller = new AbortController();
    const session = new BoundedHttpTransport({ allowedOrigins: [origin], timeoutMs: 1000 }).session({ maxRequests: 1, signal: controller.signal });
    const request = session.request(`${origin}/wait`);
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(request, { code: 'NETWORK_CANCELLED' });
    assert.equal(session.used, 1);
  } finally { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); }
});

test('adapter deadline returns even when a transport ignores abort', async () => {
  const session = new BoundedHttpTransport({ allowedOrigins: ['https://example.test'], timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}) }).session({ maxRequests: 1 });
  await assert.rejects(session.request('https://example.test/'), { code: 'NETWORK_TIMEOUT' });
  assert.equal(session.used, 1);
});
