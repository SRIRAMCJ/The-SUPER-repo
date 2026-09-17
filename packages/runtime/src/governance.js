const SCHEMA_VERSION = '0.1.0';
const DEFAULT_RULES = Object.freeze({ read: Object.freeze(['bootstrap', 'initializing', 'ready', 'running', 'draining', 'stopping', 'stopped', 'failed']), control: Object.freeze(['ready', 'running', 'draining']) });
export class RuntimeGovernance {
  constructor({ lifecycle = null, policyEngine = null, rules = {}, clock = () => new Date(), maxDecisions = 500 } = {}) {
    if (lifecycle && typeof lifecycle.getState !== 'function') throw new TypeError('lifecycle must expose getState()');
    if (policyEngine && typeof policyEngine.authorize !== 'function') throw new TypeError('policyEngine must expose authorize()');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxDecisions) || maxDecisions < 1) throw new TypeError('maxDecisions must be a positive integer');
    this.lifecycle = lifecycle; this.policyEngine = policyEngine; this.clock = clock; this.maxDecisions = maxDecisions; this.rules = normalizeRules(rules); this.decisions = [];
  }
  authorize(operation, context = {}) {
    const definition = normalizeOperation(operation); const state = this.lifecycle?.getState?.().state ?? 'running'; const allowedStates = this.rules[definition.classification] ?? [];
    let allowed = allowedStates.includes(state); let reason = allowed ? 'Lifecycle state permits operation' : `Operation ${definition.id} is not permitted while runtime is ${state}`; let policy = null;
    if (allowed && this.policyEngine) { policy = this.policyEngine.authorize({ id: definition.id, name: definition.id, risk: riskFor(definition.classification), permissions: definition.permissions ?? [] }, context); allowed = policy.allowed === true; reason = policy.reason ?? (allowed ? 'Policy permits operation' : 'Denied by policy'); }
    const decision = Object.freeze({ schemaVersion: SCHEMA_VERSION, timestamp: this.clock().toISOString(), operationId: definition.id, classification: definition.classification, lifecycleState: state, allowed, reason, policy: policy ? structuredClone(policy) : null });
    this.decisions.push(decision); if (this.decisions.length > this.maxDecisions) this.decisions.shift(); return decision;
  }
  getDecisions(limit = 100) { if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer'); return Object.freeze(structuredClone(this.decisions.slice(-limit))); }
  snapshot() { return Object.freeze(structuredClone({ schemaVersion: SCHEMA_VERSION, type: 'runtime-governance', lifecycleState: this.lifecycle?.getState?.().state ?? null, rules: this.rules, recentDecisions: this.getDecisions(20) })); }
}
function normalizeRules(rules) { const merged = { ...DEFAULT_RULES, ...rules }; for (const key of Object.keys(merged)) if (!Array.isArray(merged[key]) || merged[key].some((state) => typeof state !== 'string')) throw new TypeError(`Governance rule ${key} must be an array of states`); return Object.freeze(Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, Object.freeze([...value])] ))); }
function normalizeOperation(operation) { if (!operation || typeof operation !== 'object') throw new TypeError('operation must be an object'); const id = String(operation.id ?? operation.command ?? '').trim(); if (!id) throw new TypeError('operation requires an id'); return { ...operation, id, classification: String(operation.classification ?? 'read') }; }
function riskFor(classification) { return classification === 'control' ? 'high' : 'none'; }
export { SCHEMA_VERSION as RUNTIME_GOVERNANCE_SCHEMA_VERSION };
