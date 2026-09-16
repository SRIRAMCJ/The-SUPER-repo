const DECLARATIVE_KINDS = new Set(['workflow', 'mission', 'team', 'policy', 'evaluation', 'benchmark']);
const CAPABILITY_KINDS = new Set(['agent','skill','tool','command','workflow','team','mission','model','memory','artifact','plugin','policy','evaluation','benchmark','event','execution']);

export class CapabilityRegistry {
  #capabilities = new Map();

  register(manifest, handler = null) {
    validateCapability(manifest);
    if (!DECLARATIVE_KINDS.has(manifest.kind) && typeof handler !== 'function') {
      throw new TypeError(`Executable handler required for ${manifest.id}`);
    }
    if (typeof handler !== 'function' && handler !== null) throw new TypeError(`Handler must be a function or null for ${manifest.id}`);
    if (this.#capabilities.has(manifest.id)) throw new Error(`Capability already registered: ${manifest.id}`);
    this.#capabilities.set(manifest.id, { manifest: Object.freeze(structuredClone(manifest)), handler });
    return manifest.id;
  }

  resolve(id) { return this.#capabilities.get(id); }

  require(id) {
    const entry = this.resolve(id);
    if (!entry) throw new Error(`Capability not found: ${id}`);
    if (['disabled', 'deprecated'].includes(entry.manifest.status)) throw new Error(`Capability unavailable: ${id} (${entry.manifest.status})`);
    return entry;
  }

  list(kind) { return [...this.#capabilities.values()].map(({ manifest }) => manifest).filter((item) => !kind || item.kind === kind); }
}

export function validateCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Capability must be an object');
  const required = ['schemaVersion','id','kind','name','version','status','description','provenance'];
  for (const key of required) if (!(key in value)) throw new Error(`Missing capability field: ${key}`);
  if (value.schemaVersion !== '0.1.0') throw new Error(`Unsupported schemaVersion: ${value.schemaVersion}`);
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(value.id)) throw new Error(`Invalid capability id: ${value.id}`);
  if (!CAPABILITY_KINDS.has(value.kind)) throw new Error(`Invalid capability kind: ${value.kind}`);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error(`Invalid version: ${value.version}`);
  if (!['experimental','alpha','beta','stable','deprecated','disabled'].includes(value.status)) throw new Error(`Invalid status: ${value.status}`);
  if (!value.provenance || typeof value.provenance !== 'object' || !value.provenance.sourceType) throw new Error('Capability provenance.sourceType is required');
  return true;
}
