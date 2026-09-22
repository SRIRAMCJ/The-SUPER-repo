import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const AUTH_VERSION = '1.0';
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
const ROLES = new Set(['controller', 'worker']);
const METHODS_BY_ROLE = Object.freeze({
  controller: new Set(['execute', 'cancel', 'inspect']),
  worker: new Set(['heartbeat']),
});

export const REMOTE_EXECUTION_AUTH_SCHEMA_VERSION = SCHEMA_VERSION;
export const REMOTE_EXECUTION_AUTH_VERSION = AUTH_VERSION;

export function createRemoteIdentity({
  principalId,
  role,
  instanceId = randomUUID(),
  issuedAt = Date.now(),
  expiresAt = issuedAt + DEFAULT_CREDENTIAL_TTL_MS,
  keyId,
} = {}) {
  if (typeof principalId !== 'string' || !principalId.trim()) throw new TypeError('principalId must be a non-empty string');
  if (!ROLES.has(role)) throw new TypeError('role must be controller or worker');
  if (typeof instanceId !== 'string' || !instanceId.trim()) throw new TypeError('instanceId must be a non-empty string');
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new TypeError('invalid credential lifetime');
  if (typeof keyId !== 'string' || !keyId.trim()) throw new TypeError('keyId must be a non-empty string');
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, authVersion: AUTH_VERSION, principalId, role, instanceId, issuedAt, expiresAt, keyId });
}

export class RemoteAuthKeyRing {
  #keys = new Map();
  #activeKeyId = null;

  addKey({ keyId, secret, active = false } = {}) {
    if (typeof keyId !== 'string' || !keyId.trim()) throw new TypeError('keyId must be a non-empty string');
    if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('secret must contain at least 16 characters');
    this.#keys.set(keyId, secret);
    if (active || this.#activeKeyId === null) this.#activeKeyId = keyId;
    return Object.freeze({ keyId, active: this.#activeKeyId === keyId });
  }

  rotate({ keyId, secret } = {}) {
    return this.addKey({ keyId, secret, active: true });
  }

  retire(keyId) {
    if (!this.#keys.has(keyId)) return false;
    if (this.#activeKeyId === keyId) throw Object.assign(new Error('cannot retire active authentication key'), { code: 'ACTIVE_KEY_RETIRE_FORBIDDEN' });
    this.#keys.delete(keyId);
    return true;
  }

  get activeKeyId() { return this.#activeKeyId; }

  has(keyId) { return this.#keys.has(keyId); }

  secretFor(keyId) { return this.#keys.get(keyId) ?? null; }
}

export function signRemoteEnvelope({ identity, envelope, secret } = {}) {
  if (!identity || !envelope || typeof secret !== 'string') throw new TypeError('identity, envelope and secret are required');
  const material = canonicalize({ identity, envelope });
  return createHmac('sha256', secret).update(material).digest('base64url');
}

export function verifyRemoteEnvelope({ identity, envelope, signature, secret } = {}) {
  if (typeof signature !== 'string' || typeof secret !== 'string') return { ok: false, code: 'INVALID_SIGNATURE' };
  const expected = signRemoteEnvelope({ identity, envelope, secret });
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, code: 'INVALID_SIGNATURE' };
  return { ok: true, code: 'AUTHENTICATED' };
}

export class RemoteAuthenticationSession {
  #keyRing;
  #clock;
  #maxClockSkewMs;
  #seenNonces = new Set();
  #identities = new Map();

  constructor({ keyRing, clock = () => Date.now(), maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS } = {}) {
    if (!keyRing || typeof keyRing.secretFor !== 'function') throw new TypeError('keyRing must expose secretFor()');
    this.#keyRing = keyRing;
    this.#clock = clock;
    this.#maxClockSkewMs = maxClockSkewMs;
  }

  registerIdentity(identity) {
    this.#identities.set(identity.principalId, identity);
    return identity;
  }

  authenticate({ identity, envelope, signature, nonce = randomUUID() } = {}) {
    const now = this.#clock();
    const identityError = validateIdentity(identity, { now, maxClockSkewMs: this.#maxClockSkewMs });
    if (!identityError.ok) return identityError;
    const secret = this.#keyRing.secretFor(identity.keyId);
    if (!secret) return { ok: false, code: 'UNKNOWN_KEY' };
    if (this.#seenNonces.has(nonce)) return { ok: false, code: 'REPLAY_NONCE', retryable: false };
    const signatureResult = verifyRemoteEnvelope({ identity, envelope, signature, secret });
    if (!signatureResult.ok) return signatureResult;
    this.#seenNonces.add(nonce);
    this.#identities.set(identity.principalId, identity);
    return { ok: true, code: 'AUTHENTICATED', principalId: identity.principalId, role: identity.role, keyId: identity.keyId, nonce };
  }

  authorize({ identity, method } = {}) {
    const allowed = METHODS_BY_ROLE[identity?.role];
    if (!allowed?.has(method)) return { ok: false, code: 'UNAUTHORIZED_ROLE' };
    return { ok: true, code: 'AUTHORIZED' };
  }
}

export function createSignedEnvelope({ identity, envelope, keyRing, nonce = randomUUID() } = {}) {
  const secret = keyRing?.secretFor(identity?.keyId);
  if (!secret) throw Object.assign(new Error('Unknown authentication key'), { code: 'UNKNOWN_KEY' });
  return Object.freeze({
    authVersion: AUTH_VERSION,
    identity: structuredClone(identity),
    nonce,
    signature: signRemoteEnvelope({ identity, envelope, secret }),
  });
}

export function validateIdentity(identity, { now = Date.now(), maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS } = {}) {
  if (!identity || identity.schemaVersion !== SCHEMA_VERSION || identity.authVersion !== AUTH_VERSION) return { ok: false, code: 'INVALID_IDENTITY' };
  if (!ROLES.has(identity.role)) return { ok: false, code: 'INVALID_ROLE' };
  if (typeof identity.principalId !== 'string' || typeof identity.instanceId !== 'string' || typeof identity.keyId !== 'string') return { ok: false, code: 'INVALID_IDENTITY' };
  if (!Number.isFinite(identity.issuedAt) || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= identity.issuedAt) return { ok: false, code: 'INVALID_CREDENTIAL_LIFETIME' };
  if (now < identity.issuedAt - maxClockSkewMs) return { ok: false, code: 'CREDENTIAL_NOT_YET_VALID' };
  if (now > identity.expiresAt) return { ok: false, code: 'CREDENTIAL_EXPIRED' };
  return { ok: true, code: 'VALID_IDENTITY' };
}

export function canonicalize(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
