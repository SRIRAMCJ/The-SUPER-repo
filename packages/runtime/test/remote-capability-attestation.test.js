import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteAuthKeyRing,
  createRemoteIdentity,
} from '../src/remote-execution-auth.js';
import {
  capabilityFingerprint,
  createCapabilityAttestation,
  validateCapabilityAttestation,
} from '../src/remote-capability-attestation.js';

const SECRET = '0123456789abcdef0123456789abcdef';

function fixture(now = 100_000) {
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
  return { keyRing, identity, now };
}

test('capability fingerprint is deterministic across ordering', () => {
  const left = capabilityFingerprint({ capabilities: ['runtime.z', 'runtime.a'], protocolVersions: ['1.0', '0.9'] });
  const right = capabilityFingerprint({ capabilities: ['runtime.a', 'runtime.z'], protocolVersions: ['0.9', '1.0'] });
  assert.equal(left, right);
});

test('capability changes produce a different fingerprint', () => {
  const left = capabilityFingerprint({ capabilities: ['runtime.execute'], protocolVersions: ['1.0'] });
  const right = capabilityFingerprint({ capabilities: ['runtime.execute', 'runtime.inspect'], protocolVersions: ['1.0'] });
  assert.notEqual(left, right);
});

test('duplicate capabilities are rejected', () => {
  const { keyRing, identity, now } = fixture();
  assert.throws(() => createCapabilityAttestation({
    identity, capabilities: ['runtime.execute', 'runtime.execute'], protocolVersions: ['1.0'], keyRing, issuedAt: now, expiresAt: now + 1000,
  }), error => error.code === 'DUPLICATE_CAPABILITY');
});

test('attestation validates identity, signature, freshness and fingerprint', () => {
  const { keyRing, identity, now } = fixture();
  const attestation = createCapabilityAttestation({
    identity,
    capabilities: ['runtime.execute', 'runtime.inspect'],
    protocolVersions: ['1.0'],
    keyRing,
    nonce: 'attestation-1',
    issuedAt: now,
    expiresAt: now + 1000,
  });
  const result = validateCapabilityAttestation(attestation, {
    identity,
    now: now + 10,
    supportedProtocolVersions: ['1.0'],
    keyRing,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fingerprint, attestation.fingerprint);
});

test('tampered manifest, identity and nonce are rejected', () => {
  const { keyRing, identity, now } = fixture();
  const attestation = createCapabilityAttestation({
    identity, capabilities: ['runtime.execute'], protocolVersions: ['1.0'], keyRing, nonce: 'attestation-2', issuedAt: now, expiresAt: now + 1000,
  });
  assert.equal(validateCapabilityAttestation({ ...attestation, capabilities: ['runtime.other'] }, { identity, now, keyRing }).code, 'CAPABILITY_FINGERPRINT_MISMATCH');
  assert.equal(validateCapabilityAttestation(attestation, { identity: { ...identity, instanceId: 'other' }, now, keyRing }).code, 'ATTESTATION_IDENTITY_MISMATCH');
  assert.equal(validateCapabilityAttestation({ ...attestation, nonce: 'changed' }, { identity, now, keyRing }).code, 'INVALID_ATTESTATION_SIGNATURE');
});

test('expired and protocol-incompatible attestations fail closed', () => {
  const { keyRing, identity, now } = fixture();
  const attestation = createCapabilityAttestation({
    identity, capabilities: ['runtime.execute'], protocolVersions: ['0.9'], keyRing, issuedAt: now - 1000, expiresAt: now - 1,
  });
  assert.equal(validateCapabilityAttestation(attestation, { identity, now, supportedProtocolVersions: ['1.0'], keyRing }).code, 'ATTESTATION_EXPIRED');
  const fresh = createCapabilityAttestation({
    identity, capabilities: ['runtime.execute'], protocolVersions: ['0.9'], keyRing, issuedAt: now, expiresAt: now + 1000,
  });
  assert.equal(validateCapabilityAttestation(fresh, { identity, now, supportedProtocolVersions: ['1.0'], keyRing }).code, 'ATTESTATION_PROTOCOL_MISMATCH');
});

test('key rotation accepts new attestations and retires old signing keys', () => {
  const { keyRing, identity, now } = fixture();
  keyRing.rotate({ keyId: 'key-2', secret: 'abcdef0123456789abcdef0123456789' });
  const rotatedIdentity = createRemoteIdentity({ ...identity, keyId: 'key-2' });
  const attestation = createCapabilityAttestation({
    identity: rotatedIdentity, capabilities: ['runtime.execute'], protocolVersions: ['1.0'], keyRing, issuedAt: now, expiresAt: now + 1000,
  });
  assert.equal(validateCapabilityAttestation(attestation, { identity: rotatedIdentity, now, keyRing }).ok, true);
  keyRing.retire('key-1');
  assert.equal(keyRing.secretFor('key-1'), null);
});
