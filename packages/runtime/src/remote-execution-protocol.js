const SCHEMA_VERSION = '0.1.0';
const DEFAULT_PROTOCOL_VERSION = '1.0';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const REMOTE_EXECUTION_PROTOCOL_SCHEMA_VERSION = SCHEMA_VERSION;
export const REMOTE_EXECUTION_PROTOCOL_VERSION = DEFAULT_PROTOCOL_VERSION;

const METHODS = new Set(['execute', 'cancel', 'heartbeat', 'inspect']);

export function createProtocolEnvelope({
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  requestId,
  method,
  executionId = null,
  payload = {},
  timestamp = Date.now(),
  traceId = null,
  deadlineAt = null,
} = {}) {
  if (typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('requestId must be a non-empty string');
  if (!METHODS.has(method)) throw new TypeError(`unsupported protocol method: ${method}`);
  if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
  if (deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt < timestamp)) throw new TypeError('deadlineAt must be null or >= timestamp');
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    protocolVersion,
    requestId,
    method,
    executionId,
    timestamp,
    deadlineAt,
    traceId,
    payload: structuredClone(payload),
  });
}

export function validateProtocolEnvelope(envelope, { now = Date.now(), supportedVersions = [DEFAULT_PROTOCOL_VERSION], maxClockSkewMs = MAX_CLOCK_SKEW_MS } = {}) {
  if (!envelope || typeof envelope !== 'object') return protocolError('INVALID_ENVELOPE');
  if (envelope.schemaVersion !== SCHEMA_VERSION) return protocolError('SCHEMA_MISMATCH');
  if (!supportedVersions.includes(envelope.protocolVersion)) return protocolError('UNSUPPORTED_PROTOCOL_VERSION');
  if (typeof envelope.requestId !== 'string' || !envelope.requestId.trim()) return protocolError('INVALID_REQUEST_ID');
  if (!METHODS.has(envelope.method)) return protocolError('UNSUPPORTED_METHOD');
  if (!Number.isFinite(envelope.timestamp)) return protocolError('INVALID_TIMESTAMP');
  if (envelope.executionId !== null && (typeof envelope.executionId !== 'string' || !envelope.executionId.trim())) return protocolError('INVALID_EXECUTION_ID');
  if (envelope.deadlineAt !== null && !Number.isFinite(envelope.deadlineAt)) return protocolError('INVALID_DEADLINE');
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return protocolError('INVALID_PAYLOAD');
  if (Math.abs(now - envelope.timestamp) > maxClockSkewMs) return protocolError('CLOCK_SKEW');
  if (envelope.deadlineAt !== null && Number.isFinite(envelope.deadlineAt) && now > envelope.deadlineAt) return protocolError('DEADLINE_EXCEEDED', true);
  return { ok: true, code: 'VALID' };
}

export function negotiateProtocol({ offered = [], supported = [DEFAULT_PROTOCOL_VERSION] } = {}) {
  if (!Array.isArray(offered) || !Array.isArray(supported)) throw new TypeError('offered and supported must be arrays');
  const common = offered.filter((version) => supported.includes(version));
  if (common.length === 0) return Object.freeze({ state: 'incompatible', code: 'UNSUPPORTED_PROTOCOL_VERSION' });
  return Object.freeze({ state: 'negotiated', protocolVersion: common[common.length - 1] });
}

export class RemoteProtocolSession {
  #supportedVersions;
  #clock;
  #maxClockSkewMs;
  #negotiatedVersion = null;
  #seenRequests = new Set();

  constructor({ supportedVersions = [DEFAULT_PROTOCOL_VERSION], clock = () => Date.now(), maxClockSkewMs = MAX_CLOCK_SKEW_MS } = {}) {
    if (!Array.isArray(supportedVersions) || supportedVersions.length === 0) throw new TypeError('supportedVersions must be non-empty');
    this.#supportedVersions = [...new Set(supportedVersions)];
    this.#clock = clock;
    this.#maxClockSkewMs = maxClockSkewMs;
  }

  validate(envelope) {
    return validateProtocolEnvelope(envelope, {
      now: this.#clock(),
      supportedVersions: this.#supportedVersions,
      maxClockSkewMs: this.#maxClockSkewMs,
    });
  }

  negotiate(peerVersions) {
    const result = negotiateProtocol({ offered: peerVersions, supported: this.#supportedVersions });
    if (result.state === 'negotiated') this.#negotiatedVersion = result.protocolVersion;
    return result;
  }

  accept(envelope) {
    const validation = this.validate(envelope);
    if (!validation.ok) return validation;
    if (this.#negotiatedVersion && envelope.protocolVersion !== this.#negotiatedVersion) return protocolError('PROTOCOL_NOT_NEGOTIATED');
    if (this.#seenRequests.has(envelope.requestId)) return protocolError('DUPLICATE_REQUEST', true);
    this.#seenRequests.add(envelope.requestId);
    return { ok: true, code: 'ACCEPTED' };
  }

  get negotiatedVersion() { return this.#negotiatedVersion; }
}

function protocolError(code, retryable = false) {
  return { ok: false, code, retryable };
}
