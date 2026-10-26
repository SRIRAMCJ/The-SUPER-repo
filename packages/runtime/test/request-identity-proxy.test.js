import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRequestIdentity } from '../src/index.js';

test('trusted proxy chain selects the nearest untrusted hop', () => {
  const identity = new RuntimeRequestIdentity({ allowForwarded: true, trustedProxies: ['10.0.0.2', '10.0.0.3'] });
  const resolve = (value, remoteAddress = '10.0.0.3') => identity.resolve({ remoteAddress, headers: { 'x-forwarded-for': value } });
  assert.equal(resolve('192.0.2.99, 198.51.100.7, 10.0.0.2').principal, '198.51.100.7');
  assert.equal(resolve('198.51.100.7', '203.0.113.9').principal, '203.0.113.9');
  assert.equal(resolve('198.51.100.7, unknown').principal, '10.0.0.3');
  assert.equal(resolve('198.51.100.7, 10.0.0.2').source, 'forwarded-for');
});

test('proxy configuration rejects hostnames and oversized chains fall back to socket identity', () => {
  assert.throws(() => new RuntimeRequestIdentity({ trustedProxies: ['proxy.local'], allowForwarded: true }), /IP addresses/);
  const identity = new RuntimeRequestIdentity({ allowForwarded: true, trustedProxies: ['127.0.0.1'] });
  const request = { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': Array(17).fill('192.0.2.1').join(',') } };
  assert.equal(identity.resolve(request).principal, '127.0.0.1');
});
