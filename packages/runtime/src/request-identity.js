const SCHEMA_VERSION = '0.1.0';

export class RuntimeRequestIdentity {
  constructor({ trustedProxies = [], allowForwarded = false, header = 'x-client-id' } = {}) {
    if (!Array.isArray(trustedProxies)) throw new TypeError('trustedProxies must be an array');
    if (typeof allowForwarded !== 'boolean' || typeof header !== 'string' || !header.trim()) throw new TypeError('invalid request identity configuration');
    this.trustedProxies = new Set(trustedProxies.map((value) => normalize(value)).filter(Boolean));
    this.allowForwarded = allowForwarded;
    this.header = header.toLowerCase();
  }

  resolve(request = {}) {
    const headers = normalizeHeaders(request.headers);
    const explicit = normalize(headers[this.header]);
    if (explicit) return freeze({ schemaVersion: SCHEMA_VERSION, source: 'client-id', principal: explicit });

    const remote = normalize(request.remoteAddress ?? request.socket?.remoteAddress);
    if (this.allowForwarded && remote && this.trustedProxies.has(remote)) {
      const forwarded = firstForwarded(headers['x-forwarded-for']);
      if (forwarded) return freeze({ schemaVersion: SCHEMA_VERSION, source: 'forwarded-for', principal: forwarded });
    }

    if (remote) return freeze({ schemaVersion: SCHEMA_VERSION, source: 'remote-address', principal: remote });
    const fallback = normalize(request.clientKey);
    if (fallback) return freeze({ schemaVersion: SCHEMA_VERSION, source: 'client-key', principal: fallback });
    return freeze({ schemaVersion: SCHEMA_VERSION, source: 'anonymous', principal: 'anonymous' });
  }

  snapshot() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime-request-identity',
      trustedProxyCount: this.trustedProxies.size,
      allowForwarded: this.allowForwarded,
      header: this.header,
    });
  }
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
}
function firstForwarded(value) {
  if (typeof value !== 'string') return null;
  return normalize(value.split(',')[0]);
}
function normalize(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 256) : null;
}
function freeze(value) {
  return deepFreeze(structuredClone(value));
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
export { SCHEMA_VERSION as RUNTIME_REQUEST_IDENTITY_SCHEMA_VERSION };
