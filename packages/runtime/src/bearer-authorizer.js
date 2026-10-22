import { createHash, timingSafeEqual } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9._~-]{32,4096}$/;

// The provider owns credential storage and rotation. This adapter never caches
// its result, so a revoked digest stops authorizing on the next request.
export class RuntimeBearerAuthorizer {
  constructor({ credentials, clock = () => Date.now(), maxCredentials = 1000 } = {}) {
    if (typeof credentials !== 'function' || typeof clock !== 'function') throw new TypeError('credentials and clock functions are required');
    if (!Number.isSafeInteger(maxCredentials) || maxCredentials < 1) throw new TypeError('maxCredentials must be a positive integer');
    Object.assign(this, { credentials, clock, maxCredentials });
    this.authorize = this.authorize.bind(this);
  }

  async authorize({ request } = {}) {
    const raw = request?.headers?.authorization ?? request?.headers?.Authorization;
    if (typeof raw !== 'string') return false;
    const match = /^Bearer ([A-Za-z0-9._~-]{32,4096})$/i.exec(raw);
    if (!match || !TOKEN.test(match[1])) return false;
    const now = this.clock();
    if (!Number.isFinite(now)) throw new TypeError('clock must return a finite timestamp');
    const entries = await this.credentials();
    if (!Array.isArray(entries) || entries.length > this.maxCredentials) throw new TypeError('Invalid credential source');
    const supplied = createHash('sha256').update(match[1], 'utf8').digest();
    const seen = new Set();
    let principal = null;
    for (const entry of entries) {
      if (!entry || typeof entry.principal !== 'string' || !entry.principal.trim() || entry.principal.length > 256 ||
        typeof entry.digest !== 'string' || !DIGEST.test(entry.digest) || seen.has(entry.digest) ||
        !Number.isFinite(entry.expiresAt) || (entry.notBefore !== undefined && !Number.isFinite(entry.notBefore))) {
        throw new TypeError('Invalid credential source');
      }
      seen.add(entry.digest);
      const matched = timingSafeEqual(supplied, Buffer.from(entry.digest, 'hex'));
      if (matched && now < entry.expiresAt && (entry.notBefore === undefined || now >= entry.notBefore)) principal = entry.principal.trim();
    }
    return principal === null ? false : { allowed: true, principal };
  }

  snapshot() { return { schemaVersion: SCHEMA_VERSION, type: 'runtime-bearer-authorizer', maxCredentials: this.maxCredentials }; }
}

export { SCHEMA_VERSION as RUNTIME_BEARER_AUTHORIZER_SCHEMA_VERSION };
