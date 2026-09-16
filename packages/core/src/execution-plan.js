export class ExecutionPlanBuilder {
  constructor({ resolver, clock = () => new Date() } = {}) {
    if (!resolver) throw new TypeError('ExecutionPlanBuilder requires a capability resolver');
    this.resolver = resolver;
    this.clock = clock;
  }

  build(request = {}) {
    const resolved = this.resolver.resolve(request);
    if (!resolved.ok) return { ok: false, schemaVersion: '0.1.0', type: 'execution-plan', createdAt: this.clock().toISOString(), root: resolved.root, error: resolved.error };

    const steps = resolved.order.map((id, index) => {
      const capability = resolved.nodes[index];
      return Object.freeze({
        step: index + 1,
        capabilityId: id,
        kind: capability.kind,
        domain: capability.domain,
        version: capability.version,
        requires: Object.freeze([...(capability.requires ?? [])]),
        execution: index === resolved.order.length - 1 ? 'root' : 'dependency'
      });
    });

    return Object.freeze({
      ok: true,
      schemaVersion: '0.1.0',
      type: 'execution-plan',
      createdAt: this.clock().toISOString(),
      root: resolved.root,
      stepCount: steps.length,
      steps: Object.freeze(steps),
      metadata: Object.freeze({ deterministic: true, duplicateDependencies: resolved.duplicateDependencies })
    });
  }
}
