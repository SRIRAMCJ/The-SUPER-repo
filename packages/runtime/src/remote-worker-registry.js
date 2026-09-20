const SCHEMA_VERSION = '0.2.0';

export const REMOTE_WORKER_PROTOCOL_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteWorkerRegistry {
  #workers = new Map();
  #clock;

  constructor({ clock = () => new Date() } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.#clock = clock;
  }

  register({ workerId, capabilities = [], metadata = {} } = {}) {
    validateWorkerId(workerId);
    if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string' || !item.trim())) throw new TypeError('capabilities must be an array of non-empty strings');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be an object');
    if (this.#workers.has(workerId)) return result('conflict', { code: 'WORKER_ALREADY_REGISTERED', workerId });
    const now = this.#clock().toISOString();
    const worker = freeze({ schemaVersion: SCHEMA_VERSION, workerId, capabilities: [...new Set(capabilities)].sort(), metadata: clone(metadata), registeredAt: now, lastHeartbeatAt: now, state: 'healthy' });
    this.#workers.set(workerId, worker);
    return freeze({ state: 'registered', worker });
  }

  heartbeat(workerId, { capabilities } = {}) {
    validateWorkerId(workerId);
    const current = this.#workers.get(workerId);
    if (!current) return result('not_found', { code: 'WORKER_NOT_FOUND', workerId });
    const next = freeze({ ...current, capabilities: capabilities === undefined ? current.capabilities : [...new Set(validateCapabilities(capabilities))].sort(), lastHeartbeatAt: this.#clock().toISOString(), state: 'healthy' });
    this.#workers.set(workerId, next);
    return freeze({ state: 'healthy', worker: next });
  }

  markUnhealthy(workerId, reason = 'heartbeat timeout') {
    validateWorkerId(workerId);
    const current = this.#workers.get(workerId);
    if (!current) return result('not_found', { code: 'WORKER_NOT_FOUND', workerId });
    const next = freeze({ ...current, state: 'unhealthy', unhealthyReason: String(reason) });
    this.#workers.set(workerId, next);
    return freeze({ state: 'unhealthy', worker: next });
  }

  remove(workerId) {
    validateWorkerId(workerId);
    return this.#workers.delete(workerId);
  }

  resolveCapability(capabilityId) {
    if (typeof capabilityId !== 'string' || !capabilityId.trim()) return null;
    return [...this.#workers.values()].filter(worker => worker.state === 'healthy' && worker.capabilities.includes(capabilityId)).sort((a,b) => a.workerId.localeCompare(b.workerId))[0] ?? null;
  }

  get(workerId) { const worker = this.#workers.get(workerId); return worker ? freeze(worker) : null; }
  list() { return Object.freeze([...this.#workers.values()].map(freeze)); }
}

function validateWorkerId(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('workerId must be a non-empty string'); }
function validateCapabilities(value) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new TypeError('capabilities must be an array of non-empty strings'); return value; }
function validateWorkerIdAndCapability(workerId, capabilityId) { validateWorkerId(workerId); if (typeof capabilityId !== 'string' || !capabilityId.trim()) throw new TypeError('capabilityId must be a non-empty string'); }
function result(state, data) { return freeze({ schemaVersion: SCHEMA_VERSION, state, ...data }); }
function clone(value) { return structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }

export { validateWorkerIdAndCapability };
