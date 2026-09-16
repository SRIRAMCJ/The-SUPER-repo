import { CapabilityCatalog, CapabilityResolver, ExecutionPlanBuilder } from '../../core/src/index.js';

/**
 * Adapts the runtime registry into the core deterministic planning model.
 * Only capabilities with concrete runtime handlers are exposed to planning;
 * declarative manifests remain owned by their workflow/mission engines.
 */
export class RuntimePlanningBridge {
  constructor({ registry, planExecutor, defaultDomain = 'software' } = {}) {
    if (!registry) throw new TypeError('RuntimePlanningBridge requires registry');
    if (!planExecutor) throw new TypeError('RuntimePlanningBridge requires planExecutor');
    this.registry = registry;
    this.planExecutor = planExecutor;
    this.defaultDomain = defaultDomain;
  }

  build(request = {}) {
    const catalog = new CapabilityCatalog();
    for (const manifest of this.registry.list()) {
      const entry = this.registry.resolve(manifest.id);
      if (!entry || typeof entry.handler !== 'function') continue;
      catalog.register(toCatalogEntry(manifest, this.defaultDomain));
    }
    return new ExecutionPlanBuilder({ resolver: new CapabilityResolver({ catalog }) }).build(request);
  }

  async execute(request, input = {}, context = {}) {
    const plan = this.build(request);
    if (!plan.ok) return { status: 'failed', error: plan.error, plan };
    const result = await this.planExecutor.execute(plan, input, context);
    return { ...result, plan };
  }
}

function toCatalogEntry(manifest, defaultDomain) {
  return {
    id: manifest.id,
    version: manifest.version,
    domain: manifest.domain ?? defaultDomain,
    kind: manifest.kind,
    name: manifest.name,
    description: manifest.description,
    status: manifest.status,
    requires: manifest.requires ?? [],
    provenance: manifest.provenance ?? { sourceType: 'runtime' }
  };
}
