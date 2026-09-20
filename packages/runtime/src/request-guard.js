import { createHash } from 'node:crypto';
import { RuntimeRequestIdentity } from './request-identity.js';
import { RuntimeDistributedRateLimiter } from './distributed-rate-limiter.js';

const SCHEMA_VERSION = '0.3.0';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REPLAYABLE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class RuntimeRequestGuard {
  #windows = new Map();
  #idempotency = new Map();

  constructor({
    clock = () => Date.now(),
    maxRequests = 60,
    windowMs = 60_000,
    maxBodyBytes = 65_536,
    idempotencyTtlMs = 300_000,
    maxIdempotencyRecords = 1_000,
    keyResolver = null,
    identity = null,
    rateLimiter = null,
    idempotencyStore = null,
  } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    for (const [name, value] of [['maxRequests', maxRequests], ['windowMs', windowMs], ['maxBodyBytes', maxBodyBytes], ['idempotencyTtlMs', idempotencyTtlMs], ['maxIdempotencyRecords', maxIdempotencyRecords]]) {
      if (!Number.isInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer');
    }
    if (keyResolver !== null && typeof keyResolver !== 'function') throw new TypeError('keyResolver must be a function');
    if (identity !== null && typeof identity.resolve !== 'function') throw new TypeError('identity must expose resolve()');
    if (rateLimiter !== null && typeof rateLimiter.consume !== 'function') throw new TypeError('rateLimiter must expose consume()');
    if (idempotencyStore !== null && (typeof idempotencyStore.get !== 'function' || typeof idempotencyStore.put !== 'function')) throw new TypeError('idempotencyStore must expose get() and put()');
    this.clock = clock;
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxBodyBytes = maxBodyBytes;
    this.idempotencyTtlMs = idempotencyTtlMs;
    this.maxIdempotencyRecords = maxIdempotencyRecords;
    this.identity = identity ?? new RuntimeRequestIdentity();
    this.keyResolver = keyResolver;
    this.rateLimiter = rateLimiter;
    this.idempotencyStore = idempotencyStore;
  }

  async admit(request = {}) {
    this.#purge();
    const method = String(request.method ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) return denied('METHOD_NOT_ALLOWED', 'Unsupported HTTP method');
    const path = normalizePath(request.path);
    const bodyText = request.body === undefined ? '' : JSON.stringify(request.body);
    if (Buffer.byteLength(bodyText) > this.maxBodyBytes) return denied('BODY_TOO_LARGE', 'Request body exceeds ' + this.maxBodyBytes + ' bytes');

    const identity = this.keyResolver
      ? freeze({ schemaVersion: SCHEMA_VERSION, source: 'custom', principal: normalizeKey(this.keyResolver(request)) })
      : this.identity.resolve(request);
    const principal = identity.principal;
    const now = this.clock();

    if (this.rateLimiter) {
      let limited;
      try { limited = await this.rateLimiter.consume(principal); }
      catch (error) { return denied('RATE_LIMIT_STORE_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
      if (!limited.allowed) {
        return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'denied', error: { code: 'RATE_LIMITED', message: 'Request rate limit exceeded' }, retryAfterMs: limited.retryAfterMs, identity });
      }
    } else {
      const window = this.#windows.get(principal);
      if (!window || now - window.startedAt >= this.windowMs) this.#windows.set(principal, { startedAt: now, count: 1 });
      else if (window.count >= this.maxRequests) return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'denied', error: { code: 'RATE_LIMITED', message: 'Request rate limit exceeded' }, retryAfterMs: Math.max(1, this.windowMs - (now - window.startedAt)), identity });
      else window.count += 1;
    }

    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey && REPLAYABLE_METHODS.has(method)) {
      const cacheKey = principal + ':' + method + ':' + path + ':' + idempotencyKey;
      const fingerprint = fingerprintRequest(request);
      if (this.idempotencyStore?.claim) {
        let claim;
        try { claim = await this.idempotencyStore.claim(cacheKey, fingerprint, { expiresAt: now + this.idempotencyTtlMs }); }
        catch (error) { return denied('IDEMPOTENCY_STORE_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
        if (claim.state === 'conflict') return denied('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request');
        if (claim.state === 'replay') return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'replay', cacheKey, response: claim.record.response, identity });
        if (claim.state === 'in_progress') return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'in_progress', cacheKey, identity, retryAfterMs: Math.max(1, claim.record.expiresAt - now) });
        return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'accepted', cacheKey, fingerprint, identity });
      }
      const existing = this.idempotencyStore ? await this.idempotencyStore.get(cacheKey) : this.#idempotency.get(cacheKey);
      if (existing && existing.expiresAt > now) {
        if (existing.fingerprint !== fingerprint) return denied('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request');
        return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'replay', cacheKey, response: existing.response, identity });
      }
      return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'accepted', cacheKey, fingerprint, identity });
    }
    return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'accepted', cacheKey: null, fingerprint: null, identity });
  }

  complete(admission, response) {
    if (!admission || admission.decision !== 'accepted' || !admission.cacheKey) return false;
    this.#purge();
    const now = this.clock();
    const record = freeze({ schemaVersion: SCHEMA_VERSION, fingerprint: admission.fingerprint, response: response === undefined ? null : response, createdAt: now, expiresAt: now + this.idempotencyTtlMs });
    if (this.idempotencyStore) return this.idempotencyStore.put(admission.cacheKey, record, { expiresAt: record.expiresAt }).then(() => true);
    this.#idempotency.set(admission.cacheKey, record);
    while (this.#idempotency.size > this.maxIdempotencyRecords) this.#idempotency.delete(this.#idempotency.keys().next().value);
    return true;
  }

  snapshot() {
    this.#purge();
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime-request-guard',
      limits: { maxRequests: this.maxRequests, windowMs: this.windowMs, maxBodyBytes: this.maxBodyBytes, idempotencyTtlMs: this.idempotencyTtlMs },
      activeRateWindows: this.#windows.size,
      retainedIdempotencyRecords: this.#idempotency.size,
      identity: this.identity.snapshot(),
      distributedRateLimiter: this.rateLimiter ? this.rateLimiter.snapshot() : null,
      durableIdempotency: this.idempotencyStore ? true : false,
    });
  }

  #purge() {
    const now = this.clock();
    for (const [key, window] of this.#windows) if (now - window.startedAt >= this.windowMs) this.#windows.delete(key);
    for (const [key, record] of this.#idempotency) if (record.expiresAt <= now) this.#idempotency.delete(key);
  }
}

function readIdempotencyKey(request) {
  const headers = request?.headers ?? {};
  const value = headers['idempotency-key'] ?? headers['Idempotency-Key'] ?? request?.idempotencyKey ?? request?.body?.idempotencyKey;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
}
function fingerprintRequest(request) {
  const body = request.body === undefined ? null : request.body;
  const payload = JSON.stringify({ method: String(request.method ?? 'GET').toUpperCase(), path: normalizePath(request.path), body });
  return createHash('sha256').update(payload).digest('hex');
}
function normalizePath(path) {
  const value = String(path ?? '/');
  return new URL(value, 'http://super.local').pathname.replace(/\/+$/, '') || '/';
}
function normalizeKey(value) {
  const key = String(value ?? 'anonymous').trim();
  return key ? key.slice(0, 256) : 'anonymous';
}
function denied(code, message) { return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'denied', error: { code, message } }); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
export { SCHEMA_VERSION as RUNTIME_REQUEST_GUARD_SCHEMA_VERSION };
