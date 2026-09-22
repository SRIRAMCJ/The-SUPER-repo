import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteAuthKeyRing,
  RemoteAuthenticationSession,
  createRemoteIdentity,
  createSignedEnvelope,
  signRemoteEnvelope,
  validateIdentity,
} from '../src/remote-execution-auth.js';

const SECRET = '0123456789abcdef0123456789abcdef';

function fixture(now = 1_000_000) {
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'key-1', secret: SECRET, active: true });
  const identity = createRemoteIdentity({
    principalId: 'worker-a',
    role: 'worker',
    instanceId: 'worker-a-inc-1',
    issuedAt: now - 100,
    expiresAt: now + 10_000,
    keyId: 'key-1',
  });
  const envelope = { requestId: 'req-1', method: 'heartbeat', payload: { status: 'healthy' } };
  return { keyRing, identity, envelope };
}

test('authenticates a correctly signed envelope', () => {
  const now = 1_000_000;
  const { keyRing, identity, envelope } = fixture(now);
  const auth = new RemoteAuthenticationSession({ keyRing, clock: () => now });
  const signed = createSignedEnvelope({ identity, envelope, keyRing, nonce: 'nonce-1' });
  const result = auth.authenticate({ identity, envelope, signature: signed.signature, nonce: signed.nonce });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'worker');
});

test('rejects tampered payloads', () => {
  const now = 1_000_000;
  const { keyRing, identity, envelope } = fixture(now);
  const auth = new RemoteAuthenticationSession({ keyRing, clock: () => now });
  const signed = createSignedEnvelope({ identity, envelope, keyRing, nonce: 'nonce-2' });
  const result = auth.authenticate({
    identity,
    envelope: { ...envelope, payload: { status: 'compromised' } },
    signature: signed.signature,
    nonce: signed.nonce,
  });
  assert.equal(result.code, 'INVALID_SIGNATURE');
});

test('rejects credentials signed with an unknown key', () => {
  const now = 1_000_000;
  const { identity, envelope } = fixture(now);
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'key-2', secret: SECRET, active: true });
  const auth = new RemoteAuthenticationSession({ keyRing, clock: () => now });
  const unknownKeyRing = new RemoteAuthKeyRing();
  unknownKeyRing.addKey({ keyId: 'key-2', secret: SECRET, active: true });
  assert.throws(() => createSignedEnvelope({ identity, envelope, keyRing: unknownKeyRing }), error => error.code === 'UNKNOWN_KEY');
});

test('rejects expired credentials and clock-skewed credentials', () => {
  const expired = createRemoteIdentity({
    principalId: 'worker-a', role: 'worker', instanceId: 'i-1',
    issuedAt: 0, expiresAt: 500, keyId: 'key-1',
  });
  assert.equal(validateIdentity(expired, { now: 1_000 }).code, 'CREDENTIAL_EXPIRED');
  const future = createRemoteIdentity({
    principalId: 'worker-a', role: 'worker', instanceId: 'i-1',
    issuedAt: 100_000, expiresAt: 101_000, keyId: 'key-1',
  });
  assert.equal(validateIdentity(future, { now: 0, maxClockSkewMs: 100 }).code, 'CREDENTIAL_NOT_YET_VALID');
});

test('rejects replayed nonces', () => {
  const now = 1_000_000;
  const { keyRing, identity, envelope } = fixture(now);
  const auth = new RemoteAuthenticationSession({ keyRing, clock: () => now });
  const signed = createSignedEnvelope({ identity, envelope, keyRing, nonce: 'nonce-replay' });
  assert.equal(auth.authenticate({ identity, envelope, signature: signed.signature, nonce: signed.nonce }).ok, true);
  assert.equal(auth.authenticate({ identity, envelope, signature: signed.signature, nonce: signed.nonce }).code, 'REPLAY_NONCE');
});

test('enforces role/method authorization', () => {
  const now = 1_000_000;
  const { keyRing, identity } = fixture(now);
  const auth = new RemoteAuthenticationSession({ keyRing, clock: () => now });
  assert.equal(auth.authorize({ identity, method: 'heartbeat' }).ok, true);
  assert.equal(auth.authorize({ identity, method: 'execute' }).code, 'UNAUTHORIZED_ROLE');
});

test('supports key rotation without accepting retired keys', () => {
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'key-1', secret: SECRET, active: true });
  keyRing.rotate({ keyId: 'key-2', secret: 'abcdef0123456789abcdef0123456789' });
  assert.equal(keyRing.activeKeyId, 'key-2');
  assert.equal(keyRing.secretFor('key-1'), SECRET);
  keyRing.retire('key-1');
  assert.equal(keyRing.secretFor('key-1'), null);
});
