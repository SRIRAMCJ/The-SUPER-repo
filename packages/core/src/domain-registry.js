import { CapabilityCatalog } from "./capabilities.js";

export class DomainRegistry {
  constructor() {
    this.domains = new Map();
    this.capabilities = new CapabilityCatalog();
  }

  registerDomain(domain) {
    if (!domain?.id || !domain?.name) throw new TypeError("Domain id and name are required");
    if (this.domains.has(domain.id)) throw new Error(`Domain already registered: ${domain.id}`);
    this.domains.set(domain.id, Object.freeze({ ...domain }));
    return this.domains.get(domain.id);
  }

  registerCapability(capability) {
    if (!this.domains.has(capability.domain)) {
      throw new Error(`Unknown capability domain: ${capability.domain}`);
    }
    return this.capabilities.register(capability);
  }

  getDomain(id) {
    return this.domains.get(id);
  }

  listDomains() {
    return [...this.domains.values()];
  }

  listCapabilities(domain, kind) {
    return this.capabilities.list({ domain, kind });
  }
}
