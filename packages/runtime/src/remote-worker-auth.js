import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const VERSION = '0.1.0';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAC = /^[0-9a-f]{64}$/;

// Authenticates bounded JSON messages across a worker connection. Keep keys
// outside runtime configuration and use a protected transport for privacy.
export class RemoteWorkerAuthenticator {
  #key;
  #seen = new Map();

  constructor({ key, clock = () => Date.now(), nonceFactory = randomUUID, maxSkewMs = 30_000,
    maxNonces = 10_000, maxBytes = 65_536 } = {}) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 4096 ||
        typeof clock !== 'function' || typeof nonceFactory !== 'function' ||
        !Number.isSafeInteger(maxSkewMs) || maxSkewMs < 1000 || maxSkewMs > 300_000 ||
        !Number.isSafeInteger(maxNonces) || maxNonces < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 1_000_000) throw new TypeError('Invalid worker authentication configuration');
    this.#key = Buffer.from(key);
    Object.assign(this, { clock, nonceFactory, maxSkewMs, maxNonces, maxBytes });
  }

  sign({ requestId, nodeId, payload } = {}) {
    if (!ID.test(requestId) || !ID.test(nodeId)) throw new TypeError('Bounded requestId and nodeId are required');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be a JSON object');
    const issuedAt = this.#now();
    const nonce = this.nonceFactory();
    if (!ID.test(nonce)) throw new TypeError('nonceFactory must return a bounded nonce');
    const body = { schemaVersion: VERSION, type: 'remote-worker-request', requestId, nodeId, issuedAt, nonce, payload };
    const serialized = encode(body, this.maxBytes);
    return { body, mac: this.#mac(serialized) };
  }

  verify(envelope) {
    const body = envelope?.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.schemaVersion !== VERSION ||
        body.type !== 'remote-worker-request' || !ID.test(body.requestId) || !ID.test(body.nodeId) ||
        !ID.test(body.nonce) || !Number.isSafeInteger(body.issuedAt) || !body.payload ||
        typeof body.payload !== 'object' || Array.isArray(body.payload) || !MAC.test(envelope.mac)) throw fault('REMOTE_AUTH_INVALID');
    let serialized;
    try { serialized = encode(body, this.maxBytes); } catch { throw fault('REMOTE_AUTH_INVALID'); }
    const expected = Buffer.from(this.#mac(serialized), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) throw fault('REMOTE_AUTH_INVALID');
    const now = this.#now();
    if (Math.abs(now - body.issuedAt) > this.maxSkewMs) throw fault('REMOTE_AUTH_EXPIRED');
    while (this.#seen.size) {
      const [nonce, expires] = this.#seen.entries().next().value;
      if (expires >= now) break;
      this.#seen.delete(nonce);
    }
    if (this.#seen.has(body.nonce)) throw fault('REMOTE_AUTH_REPLAY');
    if (this.#seen.size >= this.maxNonces) throw fault('REMOTE_AUTH_CAPACITY');
    this.#seen.set(body.nonce, now + this.maxSkewMs);
    return structuredClone(body);
  }

  #mac(serialized) { return createHmac('sha256', this.#key).update(serialized).digest('hex'); }
  #now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('clock must return milliseconds');
    return value;
  }
}

function encode(body, maxBytes) {
  let serialized;
  try { serialized = JSON.stringify(body); } catch { throw new TypeError('Request must be JSON serializable'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > maxBytes) throw new TypeError('Request exceeds byte limit');
  return serialized;
}
function fault(code) { return Object.assign(new Error(code), { code }); }
