const SCHEMA_VERSION = '0.1.0';

export class RuntimeDistributedRateLimiter {
  constructor({ store, maxRequests = 60, windowMs = 60_000, clock = () => Date.now() } = {}) {
    if (!store || typeof store.consume !== 'function') throw new TypeError('store must expose atomic consume()');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new TypeError('maxRequests must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive integer');
    this.store = store;
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  async consume(principal) {
    const key = String(principal ?? 'anonymous').trim().slice(0, 256) || 'anonymous';
    const result = await this.store.consume(key, {
      now: this.clock(),
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
    });
    if (!result || typeof result !== 'object' || typeof result.allowed !== 'boolean') throw new TypeError('rate-limit store returned an invalid result');
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      allowed: result.allowed,
      remaining: Number.isInteger(result.remaining) ? Math.max(0, result.remaining) : 0,
      retryAfterMs: result.retryAfterMs == null ? null : Math.max(1, Number(result.retryAfterMs)),
    });
  }

  snapshot() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime-distributed-rate-limiter',
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
    });
  }
}

export class InMemoryAtomicRateLimitStore {
  #windows = new Map();

  async consume(key, { now, maxRequests, windowMs }) {
    const current = this.#windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.#windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true, remaining: maxRequests - 1, retryAfterMs: null };
    }
    if (current.count >= maxRequests) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, windowMs - (now - current.startedAt)) };
    }
    current.count += 1;
    return { allowed: true, remaining: maxRequests - current.count, retryAfterMs: null };
  }
}

function freeze(value) {
  return deepFreeze(structuredClone(value));
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
export { SCHEMA_VERSION as RUNTIME_DISTRIBUTED_RATE_LIMITER_SCHEMA_VERSION };
