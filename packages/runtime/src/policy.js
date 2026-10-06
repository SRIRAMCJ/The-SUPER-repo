const ALLOWED_RISKS = new Set(['none', 'low', 'medium', 'high', 'critical']);

export class PolicyEngine {
  constructor({ policies = [] } = {}) {
    if (!Array.isArray(policies) || policies.some((policy) => typeof policy !== 'function')) throw new TypeError('policies must be an array of functions');
    this.policies = Object.freeze([...policies]);
  }

  authorize(capability, context = {}) {
    const risk = capability?.risk ?? 'none';
    if (!ALLOWED_RISKS.has(risk)) throw new Error(`Invalid capability risk: ${risk}`);

    for (const policy of this.policies) {
      let decision;
      try { decision = policy(capability, context); }
      catch { return { allowed: false, reason: 'Policy evaluation failed' }; }
      if (decision && typeof decision.then === 'function') {
        // This interface is synchronous. Observe rejected promises without granting access.
        Promise.resolve(decision).catch(() => {});
        return { allowed: false, reason: 'Asynchronous policies are not supported by authorize()' };
      }
      if (decision === false || decision?.allowed === false) return { allowed: false, reason: decision?.reason ?? 'Denied by policy' };
      if (decision !== true && decision?.allowed !== true) return { allowed: false, reason: 'Policy did not explicitly authorize execution' };
    }

    if (risk === 'critical' && context.approval !== true) {
      return { allowed: false, reason: 'Critical-risk capability requires explicit approval' };
    }

    if (capability?.permissions?.includes?.('network') && context.network !== true) {
      return { allowed: false, reason: 'Network permission requires network-enabled execution context' };
    }

    return { allowed: true, reason: 'Authorized' };
  }
}
