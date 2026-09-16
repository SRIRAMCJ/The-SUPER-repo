export class TeamBuilder {
  constructor({ registry, planner }) {
    if (!registry || !planner) throw new TypeError('TeamBuilder requires registry and planner');
    this.registry = registry;
    this.planner = planner;
  }

  build(request, options = {}) {
    const desired = Math.max(1, Math.min(options.maxMembers ?? 4, 16));
    const plans = this.planner.plan(request, { kind: 'agent', tags: options.tags });
    const selected = plans.candidates?.slice(0, desired) ?? (plans.selection ? [plans.selection] : []);
    const members = selected.map((candidate) => ({ agent: candidate.capabilityId, task: options.task ?? request }));
    const strategy = options.strategy === 'parallel' ? 'parallel' : 'sequential';
    const maxConcurrency = Math.max(1, Math.min(Number(options.maxConcurrency ?? desired) || 1, 64));
    return {
      schemaVersion: '0.1.0',
      id: options.id ?? `team/${slug(request)}`,
      kind: 'team',
      name: options.name ?? `Team for ${request}`,
      version: '0.1.0',
      status: 'experimental',
      description: `Dynamically composed team for: ${request}`,
      provenance: { sourceType: 'native' },
      task: request,
      execution: { strategy, maxConcurrency, failFast: options.failFast !== false },
      members,
      metadata: { selection: plans }
    };
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'task';
}
