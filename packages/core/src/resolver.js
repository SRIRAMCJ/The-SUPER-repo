const ACTIVE_STATUSES = new Set(['experimental', 'alpha', 'beta', 'stable']);

export class CapabilityResolver {
  constructor({ registry, domains = null } = {}) {
    if (!registry) throw new TypeError('CapabilityResolver requires a capability catalog');
    this.registry = registry;
    this.domains = domains;
  }

  resolve(request = {}) {
    const rootId = request.capabilityId ?? request.id;
    if (typeof rootId !== 'string' || !rootId) throw new TypeError('Resolver requires capabilityId');
    const root = this.registry.get(rootId);
    if (!root) return failure('CAPABILITY_NOT_FOUND', `Capability not found: ${rootId}`, rootId);
    if (!ACTIVE_STATUSES.has(root.status)) return failure('CAPABILITY_UNAVAILABLE', `Capability unavailable: ${rootId} (${root.status})`, rootId);
    if (request.domain && root.domain !== request.domain) return failure('DOMAIN_MISMATCH', `Capability ${rootId} belongs to ${root.domain}, not ${request.domain}`, rootId);

    const nodes = new Map();
    const dependencies = new Map();
    const missing = [];
    const duplicateDependencies = [];
    const pending = [rootId];

    while (pending.length) {
      const id = pending.pop();
      if (nodes.has(id)) continue;
      const entry = this.registry.get(id);
      if (!entry) { missing.push(id); continue; }
      if (!ACTIVE_STATUSES.has(entry.status)) return failure('DEPENDENCY_UNAVAILABLE', `Dependency unavailable: ${id} (${entry.status})`, rootId, { dependencyId: id });
      if (request.domain && entry.domain !== request.domain) return failure('DEPENDENCY_DOMAIN_MISMATCH', `Dependency ${id} belongs to ${entry.domain}, outside ${request.domain}`, rootId, { dependencyId: id });

      nodes.set(id, entry);
      const requires = Array.isArray(entry.requires) ? entry.requires : [];
      const unique = [];
      const seen = new Set();
      for (const dependencyId of requires) {
        if (seen.has(dependencyId)) { duplicateDependencies.push({ capabilityId: id, dependencyId }); continue; }
        seen.add(dependencyId);
        unique.push(dependencyId);
        if (!nodes.has(dependencyId)) pending.push(dependencyId);
      }
      dependencies.set(id, unique);
    }

    if (missing.length) {
      const requiredBy = new Map();
      for (const [parent, requires] of dependencies) for (const id of requires) if (!requiredBy.has(id)) requiredBy.set(id, parent);
      return failure('DEPENDENCY_MISSING', `Missing dependencies for ${rootId}`, rootId, { missing: missing.map((id) => ({ id, requiredBy: requiredBy.get(id) ?? null })) });
    }

    const dependents = new Map([...nodes.keys()].map((id) => [id, []]));
    const indegree = new Map([...nodes.keys()].map((id) => [id, dependencies.get(id)?.length ?? 0]));
    for (const [id, requires] of dependencies) for (const dependencyId of requires) dependents.get(dependencyId).push(id);
    for (const ids of dependents.values()) ids.sort();

    const ready = new MinHeap();
    for (const id of nodes.keys()) if (indegree.get(id) === 0) ready.push(id);
    const order = [];
    while (ready.size) {
      const id = ready.pop();
      order.push(id);
      for (const dependent of dependents.get(id)) {
        const next = indegree.get(dependent) - 1;
        indegree.set(dependent, next);
        if (next === 0) ready.push(dependent);
      }
    }

    if (order.length !== nodes.size) {
      const cycle = [...nodes.keys()].filter((id) => indegree.get(id) > 0).sort();
      return failure('DEPENDENCY_CYCLE', `Dependency cycle detected involving: ${cycle.join(', ')}`, rootId, { cycle });
    }

    return { ok: true, root: rootId, nodes: order.map((id) => nodes.get(id)), order, missing: [], duplicateDependencies };
  }
}

class MinHeap {
  #values = [];
  get size() { return this.#values.length; }
  push(value) {
    const values = this.#values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (values[parent].localeCompare(value) <= 0) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }
  pop() {
    const values = this.#values;
    const root = values[0];
    const last = values.pop();
    if (values.length && last !== undefined) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= values.length) break;
        const right = left + 1;
        const child = right < values.length && values[right].localeCompare(values[left]) < 0 ? right : left;
        if (values[child].localeCompare(last) >= 0) break;
        values[index] = values[child];
        index = child;
      }
      values[index] = last;
    }
    return root;
  }
}

function failure(code, message, root, details = {}) { return { ok: false, root, error: { code, message, ...details } }; }
