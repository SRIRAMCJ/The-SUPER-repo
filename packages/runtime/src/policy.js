const ALLOWED_RISKS = new Set(['none', 'low', 'medium', 'high', 'critical']);

export class PolicyEngine {
  constructor({ policies = [] } = {}) {
    this.policies = [...policies];
  }

  authorize(capability, context = {}) {
    const risk = capability?.risk ?? 'none';
    if (!ALLOWED_RISKS.has(risk)) throw new Error(`Invalid capability risk: ${risk}`);

    for (const policy of this.policies) {
      if (typeof policy === 'function') {
        const decision = policy(capability, context);
        if (decision === false) return { allowed: false, reason: 'Denied by policy' };
        if (typeof decision === 'object' && decision?.allowed === false) return decision;
      }
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
