const VALID_MODES = new Set(['chat', 'completion', 'embedding', 'multimodal']);

export class ModelProviderRegistry {
  #providers = new Map();

  register(provider) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new TypeError('Model provider requires a non-empty id');
    }
    if (typeof provider.generate !== 'function') {
      throw new TypeError(`Model provider ${provider.id} requires generate()`);
    }
    if (this.#providers.has(provider.id)) {
      throw new Error(`Model provider already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
    return provider;
  }

  resolve(id) {
    return this.#providers.get(id) ?? null;
  }

  require(id) {
    const provider = this.resolve(id);
    if (!provider) throw Object.assign(new Error(`Unknown model provider: ${id}`), { code: 'MODEL_PROVIDER_NOT_FOUND' });
    return provider;
  }

  list() {
    return [...this.#providers.values()];
  }
}

export class ModelRuntime {
  constructor({ providers } = {}) {
    if (!providers) throw new TypeError('ModelRuntime requires a provider registry');
    this.providers = providers;
  }

  async generate(request = {}) {
    validateModelRequest(request);
    const provider = this.providers.require(request.provider);
    const startedAt = Date.now();
    const result = await provider.generate(request);
    return {
      provider: provider.id,
      model: request.model,
      mode: request.mode ?? 'chat',
      latencyMs: Date.now() - startedAt,
      ...result
    };
  }
}

function validateModelRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Model request must be an object');
  if (typeof request.provider !== 'string' || !request.provider) throw new TypeError('Model request requires provider');
  if (typeof request.model !== 'string' || !request.model) throw new TypeError('Model request requires model');
  if (request.mode !== undefined && !VALID_MODES.has(request.mode)) throw new TypeError(`Unsupported model mode: ${request.mode}`);
}
