const SCHEMA_VERSION = '0.1.0';
const DECISIONS = Object.freeze(['allow', 'deny']);

export const RUNTIME_POLICY_ENFORCEMENT_SCHEMA_VERSION = SCHEMA_VERSION;
export const RUNTIME_POLICY_DECISIONS = DECISIONS;

export class RuntimePolicyEnforcementKernel {
  constructor({ governance = null, security = null, supervisor = null, clock = () => new Date(), idFactory = defaultId, maxHistory = 256 } = {}) {
    if (governance && typeof governance.authorize !== 'function') throw new TypeError('governance must expose authorize()');
    if (security && typeof security.authorize !== 'function') throw new TypeError('security must expose authorize()');
    if (supervisor && typeof supervisor.health !== 'function') throw new TypeError('supervisor must expose health()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.governance = governance; this.security = security; this.supervisor = supervisor;
    this.clock = clock; this.idFactory = idFactory; this.maxHistory = maxHistory; this.#history = [];
  }
  #history;

  async evaluate(operation, context = {}) {
    const correlationId = context.correlationId ?? this.idFactory('policy');
    const decisionId = this.idFactory('policy-decision');
    const checks = [];
    const add = (source, result) => checks.push({ source, allowed: result.allowed === true, reason: result.reason ?? (result.allowed ? 'Allowed' : 'Denied'), result: clone(result) });

    let allowed = true;
    if (this.supervisor) {
      try {
        const health = await this.supervisor.health({ correlationId });
        if (health.state === 'failed' || health.state === 'unavailable') {
          allowed = false; add('supervisor', { allowed: false, reason: `Runtime supervisor state is ${health.state}` });
        } else add('supervisor', { allowed: true, reason: `Runtime supervisor state is ${health.state}` });
      } catch (error) {
        allowed = false; add('supervisor', { allowed: false, reason: 'Supervisor evaluation failed', error: normalizeError(error) });
      }
    }
    if (allowed && this.governance) {
      try { const result = this.governance.authorize(operation, context); add('governance', result); allowed = result.allowed === true; }
      catch (error) { allowed = false; add('governance', { allowed: false, reason: 'Governance evaluation failed', error: normalizeError(error) }); }
    }
    if (allowed && this.security) {
      try { const result = await this.security.authorize(operation, context); add('security', result); allowed = result.allowed === true; }
      catch (error) { allowed = false; add('security', { allowed: false, reason: 'Security evaluation failed', error: normalizeError(error) }); }
    }
    const result = deepFreeze({
      schemaVersion: SCHEMA_VERSION, type: 'runtime-policy-decision', decisionId, correlationId,
      generatedAt: this.clock().toISOString(), decision: allowed ? 'allow' : 'deny', allowed,
      operation: sanitizeOperation(operation), checks
    });
    this.#history.push(result); while (this.#history.length > this.maxHistory) this.#history.shift();
    return result;
  }

  async enforce(operation, context = {}, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const decision = await this.evaluate(operation, context);
    if (!decision.allowed) {
      const error = new Error(decision.checks.at(-1)?.reason ?? 'Runtime policy denied operation');
      error.code = 'POLICY_DENIED'; error.decisionId = decision.decisionId; error.correlationId = decision.correlationId;
      throw error;
    }
    return handler({ operation: sanitizeOperation(operation), context: clone(context), decision });
  }

  history() { return deepFreeze(this.#history); }
  snapshot() { return deepFreeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-policy-enforcement', generatedAt: this.clock().toISOString(), history: this.#history }); }
}

function sanitizeOperation(operation) {
  if (!operation || typeof operation !== 'object') throw new TypeError('operation must be an object');
  const output = { ...operation };
  for (const [key, value] of Object.entries(output)) if (/pass(word)?|secret|token|api[_-]?key|private[_-]?key/i.test(key)) output[key] = '[REDACTED]';
  return output;
}
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function normalizeError(error) { return { code: error?.code ?? 'POLICY_CHECK_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }
