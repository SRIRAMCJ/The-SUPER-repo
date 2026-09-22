import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const ALGORITHM = 'hmac-sha256';

export const CAPABILITY_ATTESTATION_SCHEMA_VERSION = SCHEMA_VERSION;
export const CAPABILITY_ATTESTATION_ALGORITHM = ALGORITHM;

export function canonicalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
  const normalized = capabilities.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('capabilities must contain non-empty strings');
    return value.trim();
  });
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw Object.assign(new Error('duplicate capability'), { code: 'DUPLICATE_CAPABILITY' });
  return [...unique].sort();
}

export function canonicalizeProtocolVersions(protocolVersions) {
  if (!Array.isArray(protocolVersions) || protocolVersions.length === 0) throw new TypeError('protocolVersions must be a non-empty array');
  const normalized = protocolVersions.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('protocolVersions must contain non-empty strings');
    return value.trim();
  });
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw Object.assign(new Error('duplicate protocol version'), { code: 'DUPLICATE_PROTOCOL_VERSION' });
  return [...unique].sort();
}

export function capabilityFingerprint({ capabilities, protocolVersions, schemaVersion = SCHEMA_VERSION } = {}) {
  const canonical = canonicalJson({
    schemaVersion,
    capabilities: canonicalizeCapabilities(capabilities),
    protocolVersions: canonicalizeProtocolVersions(protocolVersions),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function createCapabilityAttestation({
  identity,
  capabilities,
  protocolVersions,
  keyRing,
  nonce,
  issuedAt = Date.now(),
  expiresAt = issuedAt + DEFAULT_TTL_MS,
} = {}) {
  if (!identity || typeof identity.principalId !== 'string' || typeof identity.instanceId !== 'string' || typeof identity.keyId !== 'string') throw new TypeError('valid identity is required');
  if (!keyRing || typeof keyRing.secretFor !== 'function') throw new TypeError('keyRing must expose secretFor()');
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new TypeError('invalid attestation lifetime');
  const secret = keyRing.secretFor(identity.keyId);
  if (!secret) throw Object.assign(new Error('Unknown authentication key'), { code: 'UNKNOWN_KEY' });
  const attestation = {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    principalId: identity.principalId,
    role: identity.role,
    instanceId: identity.instanceId,
    keyId: identity.keyId,
    protocolVersions: canonicalizeProtocolVersions(protocolVersions),
    capabilities: canonicalizeCapabilities(capabilities),
    issuedAt,
    expiresAt,
  };
  const fingerprint = capabilityFingerprint(attestation);
  const signingNonce = nonce ?? `attest-${identity.principalId}-${issuedAt}-${fingerprint.slice(0, 16)}`;
  const signature = signCapabilityAttestation({ attestation: { ...attestation, fingerprint }, nonce: signingNonce, secret });
  return Object.freeze({ ...attestation, fingerprint, nonce: signingNonce, signature });
}

export function signCapabilityAttestation({ attestation, nonce, secret } = {}) {
  if (!attestation || typeof secret !== 'string' || secret.length < 16) throw new TypeError('attestation and secret are required');
  if (typeof nonce !== 'string' || !nonce.trim()) throw new TypeError('nonce must be a non-empty string');
  return createHmac('sha256', secret).update(canonicalJson({ attestation, nonce })).digest('base64url');
}

export function verifyCapabilityAttestation({ attestation, nonce, signature, secret } = {}) {
  if (typeof signature !== 'string' || typeof secret !== 'string') return { ok: false, code: 'INVALID_ATTESTATION_SIGNATURE' };
  const expected = signCapabilityAttestation({ attestation, nonce, secret });
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, code: 'INVALID_ATTESTATION_SIGNATURE' };
  return { ok: true, code: 'ATTESTATION_AUTHENTICATED' };
}

export function validateCapabilityAttestation(attestation, {
  identity,
  now = Date.now(),
  maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS,
  supportedProtocolVersions = null,
  keyRing = null,
} = {}) {
  if (!attestation || attestation.schemaVersion !== SCHEMA_VERSION || attestation.algorithm !== ALGORITHM) return { ok: false, code: 'INVALID_ATTESTATION' };
  if (!identity || attestation.principalId !== identity.principalId || attestation.role !== identity.role || attestation.instanceId !== identity.instanceId || attestation.keyId !== identity.keyId) return { ok: false, code: 'ATTESTATION_IDENTITY_MISMATCH' };
  if (!Number.isFinite(attestation.issuedAt) || !Number.isFinite(attestation.expiresAt) || attestation.expiresAt <= attestation.issuedAt) return { ok: false, code: 'INVALID_ATTESTATION_LIFETIME' };
  if (now < attestation.issuedAt - maxClockSkewMs) return { ok: false, code: 'ATTESTATION_NOT_YET_VALID' };
  if (now > attestation.expiresAt) return { ok: false, code: 'ATTESTATION_EXPIRED' };
  let capabilities;
  let protocolVersions;
  try {
    capabilities = canonicalizeCapabilities(attestation.capabilities);
    protocolVersions = canonicalizeProtocolVersions(attestation.protocolVersions);
  } catch (error) {
    return { ok: false, code: error?.code ?? 'INVALID_ATTESTATION' };
  }
  if (JSON.stringify(capabilities) !== JSON.stringify(attestation.capabilities)) return { ok: false, code: 'NON_CANONICAL_CAPABILITIES' };
  if (JSON.stringify(protocolVersions) !== JSON.stringify(attestation.protocolVersions)) return { ok: false, code: 'NON_CANONICAL_PROTOCOL_VERSIONS' };
  if (supportedProtocolVersions && !protocolVersions.some((version) => supportedProtocolVersions.includes(version))) return { ok: false, code: 'ATTESTATION_PROTOCOL_MISMATCH' };
  const expectedFingerprint = capabilityFingerprint({ capabilities, protocolVersions, schemaVersion: attestation.schemaVersion });
  if (attestation.fingerprint !== expectedFingerprint) return { ok: false, code: 'CAPABILITY_FINGERPRINT_MISMATCH' };
  if (keyRing) {
    const secret = keyRing.secretFor(attestation.keyId);
    if (!secret) return { ok: false, code: 'UNKNOWN_ATTESTATION_KEY' };
    const signatureResult = verifyCapabilityAttestation({ attestation: {
      schemaVersion: attestation.schemaVersion,
      algorithm: attestation.algorithm,
      principalId: attestation.principalId,
      role: attestation.role,
      instanceId: attestation.instanceId,
      keyId: attestation.keyId,
      protocolVersions: attestation.protocolVersions,
      capabilities: attestation.capabilities,
      issuedAt: attestation.issuedAt,
      expiresAt: attestation.expiresAt,
      fingerprint: attestation.fingerprint,
    }, nonce: attestation.nonce, signature: attestation.signature, secret });
    if (!signatureResult.ok) return signatureResult;
  }
  return { ok: true, code: 'VALID_ATTESTATION', fingerprint: expectedFingerprint, capabilities, protocolVersions };
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
