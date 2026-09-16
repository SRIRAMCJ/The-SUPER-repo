const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i',
  'in', 'into', 'is', 'it', 'me', 'of', 'on', 'or', 'please', 'repository',
  'the', 'this', 'to', 'with'
]);

export class CapabilityPlanner {
  constructor({ registry, clock = () => new Date() } = {}) {
    if (!registry) throw new TypeError('CapabilityPlanner requires a capability registry');
    this.registry = registry;
    this.clock = clock;
  }

  plan(request, { kind = 'agent', limit = 5, minimumScore = 0.15 } = {}) {
    if (typeof request !== 'string' || !request.trim()) throw new TypeError('Planner request must be a non-empty string');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Planner limit must be a positive integer');
    const queryTokens = tokenize(request);
    const candidates = this.registry.list(kind)
      .map((manifest) => ({ manifest, score: scoreManifest(manifest, queryTokens) }))
      .filter(({ score }) => score >= minimumScore)
      .sort((a, b) => b.score - a.score || a.manifest.id.localeCompare(b.manifest.id))
      .slice(0, limit);

    const selected = candidates[0] ?? null;
    return {
      schemaVersion: '0.1.0',
      type: 'capability-plan',
      createdAt: this.clock().toISOString(),
      request,
      selection: selected ? {
        capabilityId: selected.manifest.id,
        kind: selected.manifest.kind,
        score: selected.score,
        reason: explainMatch(selected.manifest, queryTokens)
      } : null,
      candidates: candidates.map(({ manifest, score }) => ({
        capabilityId: manifest.id,
        kind: manifest.kind,
        name: manifest.name,
        score,
        reason: explainMatch(manifest, queryTokens)
      }))
    };
  }
}

function tokenize(value) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g)?.filter((token) => !STOP_WORDS.has(token)) ?? [])];
}

function manifestText(manifest) {
  return [manifest.name, manifest.description, manifest.role, ...(manifest.tags ?? []), ...(manifest.capabilities ?? [])].join(' ').toLowerCase();
}

function scoreManifest(manifest, queryTokens) {
  if (!queryTokens.length) return 0;
  const text = manifestText(manifest);
  const matched = queryTokens.filter((token) => text.includes(token));
  const exactNameTokens = tokenize(manifest.name);
  const nameMatches = queryTokens.filter((token) => exactNameTokens.includes(token)).length;
  return Math.min(1, (matched.length / queryTokens.length) * 0.75 + (nameMatches / Math.max(1, queryTokens.length)) * 0.25);
}

function explainMatch(manifest, queryTokens) {
  const text = manifestText(manifest);
  const matched = queryTokens.filter((token) => text.includes(token));
  return matched.length ? `Matched: ${matched.join(', ')}` : 'No semantic token match';
}
