import { createHash } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
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
    keyResolver = defaultKeyResolver,
  } = {}) {
    if (typeof clock !== 'function' || typeof keyResolver !== 'function') throw new TypeError('clock and keyResolver must be functions');
    for (const [name, value] of [['maxRequests', maxRequests], ['windowMs', windowMs], ['maxBodyBytes', maxBodyBytes], ['idempotencyTtlMs', idempotencyTtlMs], ['maxIdempotencyRecords', maxIdempotencyRecords]]) {
      if (!Number.isInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer');
    }
    this.clock = clock;
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxBodyBytes = maxBodyBytes;
    this.idempotencyTtlMs = idempotencyTtlMs;
    this.maxIdempotencyRecords = maxIdempotencyRecords;
    this.keyResolver = keyResolver;
  }

  admit(request = {}) {
    this.#purge();
    const method = String(request.method ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) return denied('METHOD_NOT_ALLOWED', 'Unsupported HTTP method');
    const path = normalizePath(request.path);
    const bodyText = request.body === undefined ? '' : JSON.stringify(request.body);
    const bodyBytes = Buffer.byteLength(bodyText);
    if (bodyBytes > this.maxBodyBytes) return denied('BODY_TOO_LARGE', 'Request body exceeds ' + this.maxBodyBytes + ' bytes');

    const principal = normalizeKey(this.keyResolver(request));
    const now = this.clock();
    const window = this.#windows.get(principal);
    if (!window || now - window.startedAt >= this.windowMs) {
      this.#windows.set(principal, { startedAt: now, count: 1 });
    } else if (window.count >= this.maxRequests) {
      return freeze({
        schemaVersion: SCHEMA_VERSION,
        decision: 'denied',
        error: { code: 'RATE_LIMITED', message: 'Request rate limit exceeded' },
        retryAfterMs: Math.max(1, this.windowMs - (now - window.startedAt)),
      });
    } else {
      window.count += 1;
    }

    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey && REPLAYABLE_METHODS.has(method)) {
      const cacheKey = principal + ':' + method + ':' + path + ':' + idempotencyKey;
      const fingerprint = fingerprintRequest(request);
      const existing = this.#idempotency.get(cacheKey);
      if (existing && existing.expiresAt > now) {
        if (existing.fingerprint !== fingerprint) return denied('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request');
        return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'replay', cacheKey, response: existing.response });
      }
      return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'accepted', cacheKey, fingerprint });
    }

    return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'accepted', cacheKey: null, fingerprint: null });
  }

  complete(admission, response) {
    if (!admission || admission.decision !== 'accepted' || !admission.cacheKey) return false;
    this.#purge();
    const now = this.clock();
    this.#idempotency.set(admission.cacheKey, freeze({
      schemaVersion: SCHEMA_VERSION,
      fingerprint: admission.fingerprint,
      response: response === undefined ? null : response,
      createdAt: now,
      expiresAt: now + this.idempotencyTtlMs,
    }));
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
    });
  }

  #purge() {
    const now = this.clock();
    for (const [key, window] of this.#windows) if (now - window.startedAt >= this.windowMs) this.#windows.delete(key);
    for (const [key, record] of this.#idempotency) if (record.expiresAt <= now) this.#idempotency.delete(key);
  }
}

function defaultKeyResolver(request) {
  const headers = request?.headers ?? {};
  return headers['x-client-id'] ?? headers['x-forwarded-for'] ?? request?.clientKey ?? 'anonymous';
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
  const url = new URL(value, 'http://super.local');
  return url.pathname.replace(/\/+$/, '') || '/';
}

function normalizeKey(value) {
  const key = String(value ?? 'anonymous').trim();
  return key ? key.slice(0, 256) : 'anonymous';
}

function denied(code, message) {
  return freeze({ schemaVersion: SCHEMA_VERSION, decision: 'denied', error: { code, message } });
}

function freeze(value) {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export { SCHEMA_VERSION as RUNTIME_REQUEST_GUARD_SCHEMA_VERSION };
