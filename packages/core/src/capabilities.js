export class CapabilityCatalog {
  constructor(entries = []) {
    this.entries = new Map();
    for (const entry of entries) this.register(entry);
  }

  register(entry) {
    validateEntry(entry);
    if (this.entries.has(entry.id)) {
      throw new Error(`Capability already registered: ${entry.id}`);
    }
    this.entries.set(entry.id, Object.freeze({ ...entry }));
    return this.entries.get(entry.id);
  }

  get(id) {
    return this.entries.get(id);
  }

  has(id) {
    return this.entries.has(id);
  }

  list(filter = {}) {
    return [...this.entries.values()].filter((entry) =>
      (!filter.domain || entry.domain === filter.domain) &&
      (!filter.kind || entry.kind === filter.kind)
    );
  }

  resolve({ domain, kind, ids = [] } = {}) {
    const requested = ids.length
      ? ids.map((id) => this.get(id)).filter(Boolean)
      : this.list({ domain, kind });
    return requested;
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") throw new TypeError("Capability must be an object");
  for (const field of ["id", "version", "domain", "kind", "name", "description"]) {
    if (typeof entry[field] !== "string" || !entry[field]) {
      throw new TypeError(`Capability ${field} is required`);
    }
  }
  const kinds = new Set(["agent", "skill", "command", "tool", "workflow", "team", "template", "example", "benchmark"]);
  if (!kinds.has(entry.kind)) throw new TypeError(`Unsupported capability kind: ${entry.kind}`);
  if (entry.requires && (!Array.isArray(entry.requires) || entry.requires.some((v) => typeof v !== "string"))) {
    throw new TypeError("Capability requires must be an array of strings");
  }
}
