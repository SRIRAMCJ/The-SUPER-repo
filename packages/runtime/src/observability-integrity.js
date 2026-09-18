import { createHash } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';

export class ObservabilityIntegrityKernel {
  static digestEvents(events) {
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const canonical = events.map(canonicalEvent).join('\n');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  static verifyRange(events, { sourceNodeId, fromSourceSequence, toSourceSequence, expectedDigest = null } = {}) {
    validateNode(sourceNodeId);
    validateRange(fromSourceSequence, toSourceSequence);
    if (expectedDigest !== null) validateDigest(expectedDigest);
    if (!Array.isArray(events) || events.length !== toSourceSequence - fromSourceSequence + 1) {
      return freeze({ valid: false, code: 'INTEGRITY_RANGE_INCOMPLETE' });
    }
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (!event || event.sourceNodeId !== sourceNodeId || event.sourceSequence !== fromSourceSequence + i) {
        return freeze({ valid: false, code: 'INTEGRITY_RANGE_NON_CONTIGUOUS' });
      }
    }
    const digest = ObservabilityIntegrityKernel.digestEvents(events);
    if (expectedDigest !== null && digest !== expectedDigest) return freeze({ valid: false, code: 'INTEGRITY_DIGEST_MISMATCH', digest, expectedDigest });
    return freeze({ valid: true, digest, fromSourceSequence, toSourceSequence });
  }
}

function canonicalEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  return JSON.stringify({
    id: event.id ?? null,
    type: event.type ?? null,
    sourceNodeId: event.sourceNodeId ?? null,
    sourceSequence: event.sourceSequence ?? null,
    sequence: event.sequence ?? null,
    fencingToken: event.fencingToken ?? null,
    executionId: event.executionId ?? null,
    capabilityId: event.capabilityId ?? null,
    status: event.status ?? null,
    timestamp: event.timestamp ?? null,
    metadata: event.metadata ?? null,
  });
}
function validateNode(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('sourceNodeId must be a non-empty string'); }
function validateRange(from, to) { if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from) throw new TypeError('range must contain positive integer bounds'); }
function validateDigest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('expectedDigest must be a SHA-256 hex digest'); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }

export { SCHEMA_VERSION as OBSERVABILITY_INTEGRITY_SCHEMA_VERSION };
