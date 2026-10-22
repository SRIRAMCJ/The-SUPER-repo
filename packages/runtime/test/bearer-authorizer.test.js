import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ControlPlaneGateway, FileRateLimiter, RuntimeBearerAuthorizer, RuntimeRequestGuard } from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tokenA = 'a'.repeat(48);
const tokenB = 'b'.repeat(48);
const digest = (token) => createHash('sha256').update(token).digest('hex');
const credential = (token, principal, expiresAt = 5000) => ({ digest: digest(token), principal, expiresAt });

test('bearer credentials rotate and revoke without an adapter cache', async () => {
  let entries = [credential(tokenA, 'alice')];
  let now = 1000;
  const authorizer = new RuntimeBearerAuthorizer({ credentials: async () => entries, clock: () => now });
  const request = (token) => ({ request: { headers: { authorization: `Bearer ${token}` } } });
  assert.deepEqual(await authorizer.authorize(request(tokenA)), { allowed: true, principal: 'alice' });
  entries = [credential(tokenB, 'alice')];
  assert.equal(await authorizer.authorize(request(tokenA)), false);
  assert.deepEqual(await authorizer.authorize(request(tokenB)), { allowed: true, principal: 'alice' });
  now = 5000;
  assert.equal(await authorizer.authorize(request(tokenB)), false);
  assert.equal(JSON.stringify(authorizer.snapshot()).includes(tokenB), false);
});

test('invalid credential sources fail closed and malformed headers do not query the provider', async () => {
  let calls = 0;
  const authorizer = new RuntimeBearerAuthorizer({ credentials: () => { calls++; return [credential(tokenA, 'alice')]; } });
  for (const header of [`Basic ${tokenA}`, `Bearer ${tokenA},Bearer ${tokenB}`, `Bearer ${'x'.repeat(5000)}`, `Bearer ${tokenA}\nother`]) {
    assert.equal(await authorizer.authorize({ request: { headers: { authorization: header } } }), false);
  }
  assert.equal(calls, 0);
  const invalid = new RuntimeBearerAuthorizer({ credentials: () => [credential(tokenA, 'alice'), credential(tokenA, 'bob')] });
  await assert.rejects(invalid.authorize({ request: { headers: { authorization: `Bearer ${tokenA}` } } }), /Invalid credential source/);
  const failed = new RuntimeBearerAuthorizer({ credentials: () => { throw new Error('private credential detail'); } });
  const gateway = new ControlPlaneGateway({ controlPlane: { getHealth: () => ({ status: 'healthy' }), snapshot: () => ({}) }, authorize: failed.authorize });
  const response = await gateway.handle({ method: 'GET', path: '/health', headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(response.body.error.code, 'AUTHORIZATION_ERROR');
  assert.equal(JSON.stringify(response).includes('private credential detail'), false);
});

test('gateway binds bearer identities to independent replay and limits', async () => {
  const authorizer = new RuntimeBearerAuthorizer({ credentials: () => [credential(tokenA, 'alice', Date.now() + 60_000), credential(tokenB, 'bob', Date.now() + 60_000)] });
  let executions = 0;
  const gateway = new ControlPlaneGateway({ controlPlane: { getHealth: () => ({ status: 'healthy' }), snapshot: () => ({}) },
    authorize: authorizer.authorize, requestGuard: new RuntimeRequestGuard({ maxRequests: 2 }),
    commands: { list: () => [], execute: async (_command, _input, context) => {
      assert.equal(context.request.headers.authorization, undefined);
      assert.equal(context.request.headers['proxy-authorization'], undefined);
      return { ok: true, count: ++executions, principal: context.request.clientKey };
    } } });
  const address = await gateway.listen({ host: '0.0.0.0' });
  const url = `http://127.0.0.1:${address.port}/commands`;
  const send = async (token) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'proxy-authorization': `Bearer ${token}`, 'idempotency-key': 'same', 'x-client-id': 'spoofed', 'content-type': 'application/json' }, body: '{"command":"run"}' });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await send('invalid')).status, 403);
    const alice = await send(tokenA);
    const bob = await send(tokenB);
    assert.equal(alice.body.data.principal, 'auth:alice');
    assert.equal(bob.body.data.principal, 'auth:bob');
    assert.equal((await send(tokenA)).body.data.count, 1);
    assert.equal((await send(tokenB)).body.data.count, 2);
    assert.equal((await send(tokenA)).status, 429);
    assert.equal(executions, 2);
  } finally { await gateway.close(); }
});

test('shared admission limits invalid credentials before calling the provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-preauth-'));
  const filePath = join(dir, 'attempts.json');
  let calls = 0;
  const authorizer = new RuntimeBearerAuthorizer({ credentials: () => { calls++; return [credential(tokenA, 'alice', Date.now() + 60_000)]; } });
  const makeGateway = () => new ControlPlaneGateway({ controlPlane: { getHealth: () => ({ status: 'healthy' }), snapshot: () => ({}) },
    authorize: authorizer.authorize, preAuthLimiter: new FileRateLimiter({ filePath, maxRequests: 2 }) });
  const first = makeGateway();
  const second = makeGateway();
  const a = await first.listen();
  const b = await second.listen();
  const send = async (port, token, forwarded) => fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': forwarded } });
  try {
    assert.equal((await send(a.port, tokenB, '1.1.1.1')).status, 403);
    assert.equal((await send(b.port, tokenB, '2.2.2.2')).status, 403);
    const denied = await send(b.port, tokenA, '3.3.3.3');
    assert.equal(denied.status, 429);
    assert.equal((await denied.json()).error.code, 'PRE_AUTH_RATE_LIMITED');
    assert.equal(calls, 2);
  } finally { await first.close(); await second.close(); await rm(dir, { recursive: true, force: true }); }
});

test('unavailable pre-auth admission fails closed without invoking authorization', async () => {
  let calls = 0;
  const gateway = new ControlPlaneGateway({ controlPlane: { getHealth: () => ({ status: 'healthy' }), snapshot: () => ({}) },
    authorize: () => { calls++; return true; }, preAuthLimiter: { consume: async () => { throw new Error('private storage detail'); } } });
  const result = await gateway.handle({ method: 'GET', path: '/health', remoteAddress: '127.0.0.1' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'PRE_AUTH_LIMITER_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private storage detail'), false);
  assert.equal(calls, 0);
});
