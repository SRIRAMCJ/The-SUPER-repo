import { randomUUID, createHash } from 'node:crypto';

export const FAULT_INJECTION_SCHEMA_VERSION = '0.1.0';
export const FAULT_PHASES = Object.freeze(['before','during','after']);
export const RECOVERY_OUTCOMES = Object.freeze(['not_triggered','recovered','failed','skipped']);

export class FaultInjectionEngine {
  #scenarios = new Map();
  #history = [];
  #clock;
  #maxHistory;
  constructor({ clock = () => Date.now(), maxHistory = 5000 } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.#clock = clock; this.#maxHistory = maxHistory;
  }
  register({ scenarioId = randomUUID(), name, match, phase = 'before', fault = 'throw', probability = 1, maxTriggers = 1, metadata = null } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('name is required');
    if (typeof match !== 'function') throw new TypeError('match must be a function');
    if (!FAULT_PHASES.includes(phase)) throw new TypeError('invalid phase');
    if (typeof probability !== 'number' || probability < 0 || probability > 1) throw new TypeError('probability must be between 0 and 1');
    if (!Number.isInteger(maxTriggers) || maxTriggers < 1) throw new TypeError('maxTriggers must be a positive integer');
    const scenario = Object.freeze({ schemaVersion: FAULT_INJECTION_SCHEMA_VERSION, scenarioId: String(scenarioId), name: name.trim(), match, phase, fault, probability, maxTriggers, triggerCount: 0, metadata });
    this.#scenarios.set(scenario.scenarioId, scenario);
    return publicScenario(scenario);
  }
  remove(scenarioId) { return this.#scenarios.delete(String(scenarioId)); }
  clear() { this.#scenarios.clear(); }
  async evaluate(context, phase, random = Math.random) {
    if (!FAULT_PHASES.includes(phase)) throw new TypeError('invalid phase');
    const triggered = [];
    for (const [id, scenario] of this.#scenarios) {
      if (scenario.triggerCount >= scenario.maxTriggers || scenario.phase !== phase) continue;
      let matches = false;
      try { matches = Boolean(await scenario.match(context)); } catch (error) { this.#record('matcher_error', id, phase, context, error); continue; }
      if (!matches || random() > scenario.probability) continue;
      const next = { ...scenario, triggerCount: scenario.triggerCount + 1 };
      this.#scenarios.set(id, Object.freeze(next));
      const event = this.#record('fault_triggered', id, phase, context, null);
      triggered.push({ scenario: publicScenario(next), event, fault: scenario.fault });
    }
    return triggered;
  }
  history() { return this.#history.map(clone); }
  snapshot() { return Object.freeze({ schemaVersion: FAULT_INJECTION_SCHEMA_VERSION, scenarios: this.#scenarios.size, historySize: this.#history.length }); }
  #record(type, scenarioId, phase, context, error) {
    const event = { schemaVersion: FAULT_INJECTION_SCHEMA_VERSION, eventId: randomUUID(), timestamp: new Date(this.#clock()).toISOString(), type, scenarioId, phase, contextHash: fingerprintContext(context), ...(error ? { error: { name: error.name, message: error.message } } : {}) };
    this.#history.push(Object.freeze(event)); if (this.#history.length > this.#maxHistory) this.#history.splice(0, this.#history.length - this.#maxHistory);
    return event;
  }
}

export class RecoveryController {
  #recoveries = new Map();
  #history = [];
  #clock;
  #maxHistory;
  constructor({ clock = () => Date.now(), maxHistory = 5000 } = {}) {\n    if (typeof clock !== 'function') throw new TypeError('clock must be a function');\n    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');\n    this.#clock=clock; this.#maxHistory=maxHistory;\n  }
  async recover(key, { operation, attempts = 3, backoffMs = 0, shouldRetry = () => true, onAttempt = null } = {}) {
    const id = String(key);
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('attempts must be a positive integer');
    if (!Number.isInteger(backoffMs) || backoffMs < 0) throw new TypeError('backoffMs must be a non-negative integer');
    if (this.#recoveries.has(id)) return clone(this.#recoveries.get(id));
    const state = { recoveryId: randomUUID(), key: id, status: 'running', attempts: 0, startedAt: this.#clock() };
    this.#recoveries.set(id, state);
    try {
      let lastError = null;
      for (let attempt=1; attempt<=attempts; attempt++) {
        state.attempts=attempt;
        try { if (onAttempt) await onAttempt({ attempt, recoveryId: state.recoveryId }); const value=await operation({ attempt, recoveryId: state.recoveryId }); state.status='recovered'; state.completedAt=this.#clock(); state.value=value; this.#record(state); return clone(state); }
        catch(error) { lastError=error; this.#record({ ...state, status:'attempt_failed', error:{name:error.name,message:error.message} }); if (attempt===attempts || !(await shouldRetry(error, attempt))) break; if(backoffMs) await new Promise(r=>setTimeout(r,backoffMs)); }
      }
      state.status='failed'; state.completedAt=this.#clock(); state.error={name:lastError?.name??'Error',message:lastError?.message??'Recovery failed'}; this.#record(state); return clone(state);
    } finally { this.#recoveries.delete(id); }
  }
  inspect(key) { const state=this.#recoveries.get(String(key)); return state ? clone(state) : null; }
  history() { return this.#history.map(clone); }
  #record(entry) { this.#history.push(Object.freeze({ schemaVersion: FAULT_INJECTION_SCHEMA_VERSION, timestamp:new Date(this.#clock()).toISOString(), ...entry })); if(this.#history.length>this.#maxHistory)this.#history.splice(0,this.#history.length-this.#maxHistory); }
}

export async function withFaultInjection(operation, { faults = null, context = {}, recovery = null } = {}) {
  const faultEngine = faults;
  try {
    if (faultEngine) await faultEngine.evaluate(context,'before');
    const value = await operation();
    if (faultEngine) await faultEngine.evaluate(context,'after');
    return { outcome: 'succeeded', value };
  } catch (error) {
    if (!recovery) return { outcome: 'failed', error };
    const result = await recovery(error);
    return { outcome: result?.outcome === 'recovered' ? 'recovered' : 'failed', error, recovery: result };
  }
}

function publicScenario(s) { const { match, ...safe } = s; return Object.freeze({ ...safe }); }
function fingerprintContext(value) { return createHash('sha256').update(canonicalize(value)).digest('hex'); }\nfunction canonicalize(value) {\n  if (value === null || typeof value !== 'object') return JSON.stringify(value);\n  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;\n  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;\n}
function clone(value) { return structuredClone(value); }
