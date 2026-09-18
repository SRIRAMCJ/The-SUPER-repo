const SCHEMA_VERSION = '0.1.0';
const TRUST_LEVELS = new Set(['untrusted', 'trusted', 'system']);
const PERMISSIONS = new Set(['network', 'filesystem', 'subprocess', 'secrets']);
const DECISIONS = Object.freeze({ ALLOWED: 'allowed', DENIED: 'denied', INVALID: 'invalid' });
const RESERVED_CONTEXT_KEYS = new Set(['allowed', 'decision', 'security', 'permissions', 'trustLevel', 'approval', 'network']);

export class SecurityCapabilityGate {
  #decisions = [];

  constructor({ policyEngine = null, governance = null, clock = () => new Date(), maxDecisions = 1000, idFactory = defaultDecisionId } = {}) {
    if (policyEngine && typeof policyEngine.authorize !== 'function') throw new TypeError('policyEngine must expose authorize()');
    if (governance && typeof governance.authorize !== 'function') throw new TypeError('governance must expose authorize()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxDecisions) || maxDecisions < 1) throw new TypeError('maxDecisions must be a positive integer');
    this.policyEngine = policyEngine;
    this.governance = governance;
    this.clock = clock;
    this.maxDecisions = maxDecisions;
    this.idFactory = idFactory;
  }

  authorize(capability, context = {}) {
    const decisionId = this.idFactory(capability?.id ?? 'unknown');
    const timestamp = this.clock().toISOString();
    let decision;
    try {
      const normalized = normalizeRequest(capability, context);
      const governanceDecision = this.governance?.authorize(
        { id: normalized.id, classification: 'control', permissions: normalized.permissions },
        normalized.governanceContext,
      );
      if (governanceDecision && governanceDecision.allowed !== true) {
        decision = buildDecision(decisionId, timestamp, normalized, DECISIONS.DENIED, 'Governance denied capability execution', governanceDecision.reason);
      } else {
        const policyDecision = this.policyEngine?.authorize(normalized.capability, normalized.policyContext);
        if (policyDecision && policyDecision.allowed !== true) {
          decision = buildDecision(decisionId, timestamp, normalized, DECISIONS.DENIED, 'Policy denied capability execution', policyDecision.reason);
        } else {
          decision = buildDecision(decisionId, timestamp, normalized, DECISIONS.ALLOWED, 'Security checks passed', null);
        }
      }
    } catch (error) {
      decision = deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        decisionId,
        timestamp,
        capabilityId: String(capability?.id ?? ''),
        decision: DECISIONS.INVALID,
        allowed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    this.#decisions.push(decision);
    while (this.#decisions.length > this.maxDecisions) this.#decisions.shift();
    return structuredClone(decision);
  }

  getDecisions(limit = this.maxDecisions) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return structuredClone(this.#decisions.slice(-limit));
  }

  snapshot() {
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'security-capability-gate',
      maxDecisions: this.maxDecisions,
      recentDecisions: this.getDecisions(20),
    });
  }
}

function normalizeRequest(capability, context) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) throw new TypeError('Capability must be an object');
  if (typeof capability.id !== 'string' || capability.id.trim() === '') throw new TypeError('Capability id is required');
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('Security context must be an object');
  for (const key of Object.keys(context)) if (RESERVED_CONTEXT_KEYS.has(key) && key !== 'approval' && key !== 'network') throw new TypeError(`Security context cannot override protected field: ${key}`);
  const trustLevel = context.trustLevel;
  if (!TRUST_LEVELS.has(trustLevel)) throw new TypeError('Security context requires trustLevel: untrusted, trusted, or system');
  if (trustLevel === 'untrusted' && capability.risk === 'critical') throw new Error('Untrusted context cannot execute critical-risk capabilities');
  const requestedPermissions = normalizePermissions(capability.permissions);
  const grantedPermissions = normalizePermissions(context.grantedPermissions ?? []);
  if (capability.permissions?.some((permission) => !PERMISSIONS.has(permission))) throw new Error('Capability contains unsupported security permission');
  for (const permission of requestedPermissions) if (!grantedPermissions.has(permission)) throw new Error(`Security context does not grant required permission: ${permission}`);
  if (requestedPermissions.has('network') && context.network !== true) throw new Error('Network permission requires explicit network=true');
  const policyContext = { approval: context.approval === true, network: context.network === true, trustLevel };
  const governanceContext = { approval: context.approval === true, network: context.network === true };
  return {
    id: capability.id,
    permissions: [...requestedPermissions].sort(),
    capability: { id: capability.id, name: capability.name, risk: capability.risk ?? 'none', permissions: [...requestedPermissions].sort() },
    policyContext,
    governanceContext,
  };
}

function normalizePermissions(value) {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value) || value.some((permission) => typeof permission !== 'string')) throw new TypeError('Permissions must be an array of strings');
  return new Set(value.map((permission) => permission.trim()).filter(Boolean));
}

function buildDecision(decisionId, timestamp, normalized, decision, reason, detail) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    decisionId,
    timestamp,
    capabilityId: normalized.id,
    decision,
    allowed: decision === DECISIONS.ALLOWED,
    permissions: [...normalized.permissions],
    reason,
    detail,
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function defaultDecisionId(capabilityId) {
  return `security_${capabilityId.replaceAll('/', '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export { SCHEMA_VERSION as SECURITY_CAPABILITY_SCHEMA_VERSION, TRUST_LEVELS as SECURITY_TRUST_LEVELS, PERMISSIONS as SECURITY_PERMISSIONS, DECISIONS as SECURITY_DECISIONS };
