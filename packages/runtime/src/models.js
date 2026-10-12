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
    const { generate, ...metadata } = provider;
    const snapshot = freezeDeep(structuredClone(metadata));
    const entry = Object.freeze({ ...snapshot, generate: (request) => generate.call(snapshot, request) });
    this.#providers.set(snapshot.id, entry);
    return this.resolve(snapshot.id);
  }

  resolve(id) {
    const entry = this.#providers.get(id);
    if (!entry) return null;
    const { generate, ...metadata } = entry;
    return { ...structuredClone(metadata), generate };
  }

  require(id) {
    const provider = this.resolve(id);
    if (!provider) throw Object.assign(new Error(`Unknown model provider: ${id}`), { code: 'MODEL_PROVIDER_NOT_FOUND' });
    return provider;
  }

  list() {
    return [...this.#providers.keys()].map((id) => this.resolve(id));
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
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Model provider must return an object');
    return {
      ...result,
      provider: provider.id,
      model: request.model,
      mode: request.mode ?? 'chat',
      latencyMs: Date.now() - startedAt
    };
  }
}

function freezeDeep(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function validateModelRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Model request must be an object');
  if (typeof request.provider !== 'string' || !request.provider) throw new TypeError('Model request requires provider');
  if (typeof request.model !== 'string' || !request.model) throw new TypeError('Model request requires model');
  if (request.mode !== undefined && !VALID_MODES.has(request.mode)) throw new TypeError(`Unsupported model mode: ${request.mode}`);
}
