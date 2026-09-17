import { createExecutionId } from './events.js';
import { ExecutionStateStore } from './state.js';
import { PolicyEngine } from './policy.js';

const DEFAULT_STAGES = Object.freeze([
  Object.freeze({ id: 'canary', fraction: 0.1 }),
  Object.freeze({ id: 'progressive', fraction: 0.5 }),
  Object.freeze({ id: 'full', fraction: 1 })
]);

export class EvolutionControlPlane {
  constructor({ adaptationEngine, store = new ExecutionStateStore(), policyEngine = new PolicyEngine(), eventBus = null, clock = () => new Date() } = {}) {
    if (!adaptationEngine || typeof adaptationEngine.apply !== 'function' || typeof adaptationEngine.rollback !== 'function') throw new TypeError('EvolutionControlPlane requires a compatible adaptation engine');
    if (!store || typeof store.create !== 'function' || typeof store.get !== 'function' || typeof store.update !== 'function') throw new TypeError('EvolutionControlPlane requires a compatible state store');
    if (!policyEngine || typeof policyEngine.authorize !== 'function') throw new TypeError('EvolutionControlPlane requires a compatible policy engine');
    this.adaptationEngine = adaptationEngine;
    this.store = store;
    this.policyEngine = policyEngine;
    this.eventBus = eventBus;
    this.clock = clock;
  }

  async get(controlId) {
    validateId(controlId, 'controlId');
    const state = await this.store.get(stateId(controlId));
    return state ? clone(state) : null;
  }

  async list(filter = {}) {
    const states = await this.store.list({ type: 'evolution-control', ...filter });
    return states.map(clone);
  }

  async run(proposal, { stages = DEFAULT_STAGES, healthCheck, context = {}, rollbackOnFailure = true } = {}) {
    validateProposal(proposal);
    validateStages(stages);
    validateContext(context);
    if (typeof healthCheck !== 'function') throw new TypeError('EvolutionControlPlane requires a healthCheck function');

    const decision = this.policyEngine.authorize(
      { risk: proposal.metadata?.risk ?? 'low', permissions: proposal.metadata?.permissions ?? [] },
      { ...context, evolutionProposal: proposal, evolutionControl: true, stages: clone(stages) }
    );
    if (!decision?.allowed) return failure('EVOLUTION_CONTROL_POLICY_DENIED', decision?.reason ?? 'Evolution control denied by policy');

    const controlId = createExecutionId();
    const now = this.clock().toISOString();
    let state = await this.store.create({
      executionId: stateId(controlId),
      type: 'evolution-control',
      schemaVersion: '0.1.0',
      controlId,
      proposalId: proposal.proposalId,
      status: 'running',
      stageIndex: -1,
      stages: clone(stages),
      adaptations: [],
      history: [{ action: 'started', status: 'running', at: now }],
      createdAt: now,
      updatedAt: now
    });
    await this.#emit('evolution.control.started', { executionId: controlId, controlId, proposalId: proposal.proposalId, stages: clone(stages) });

    try {
      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        state = await this.#update(state, { stageIndex: index, history: [...state.history, { action: 'stage_started', stageId: stage.id, stageIndex: index, at: this.clock().toISOString() }] });
        await this.#emit('evolution.control.stage.started', { executionId: controlId, controlId, proposalId: proposal.proposalId, stageId: stage.id, stageIndex: index, fraction: stage.fraction });

        const adaptation = await this.adaptationEngine.apply(proposal, { ...context, evolutionControlId: controlId, rolloutStage: clone(stage) });
        if (adaptation.status !== 'applied') return this.#abort(state, stage, adaptation, rollbackOnFailure);

        const adaptations = [...state.adaptations, { stageId: stage.id, adaptationId: adaptation.adaptationId, revision: adaptation.revision }];
        state = await this.#update(state, { adaptations, history: [...state.history, { action: 'stage_applied', stageId: stage.id, stageIndex: index, adaptationId: adaptation.adaptationId, at: this.clock().toISOString() }] });

        let health;
        try {
          health = await healthCheck({ proposal: clone(proposal), stage: clone(stage), controlId, adaptation: clone(adaptation), context: clone(context) });
        } catch (error) {
          return this.#abort(state, stage, { status: 'failed', error: normalizeError(error) }, rollbackOnFailure, 'health_check_failed');
        }
        validateHealth(health);
        if (!health.healthy) return this.#abort(state, stage, { status: 'failed', error: { code: health.code ?? 'ROLLOUT_UNHEALTHY', message: health.reason ?? 'Health check failed' }, health }, rollbackOnFailure, 'health_check_failed');

        state = await this.#update(state, { history: [...state.history, { action: 'stage_healthy', stageId: stage.id, stageIndex: index, health: clone(health), at: this.clock().toISOString() }] });
        await this.#emit('evolution.control.stage.healthy', { executionId: controlId, controlId, proposalId: proposal.proposalId, stageId: stage.id, stageIndex: index, health: clone(health) });
      }
    } catch (error) {
      return this.#abort(state, stages[state.stageIndex] ?? null, { status: 'failed', error: normalizeError(error) }, rollbackOnFailure, 'control_execution_failed');
    }

    const finishedAt = this.clock().toISOString();
    const updated = await this.#update(state, { status: 'completed', history: [...state.history, { action: 'completed', status: 'completed', at: finishedAt }], updatedAt: finishedAt });
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-control-result', status: 'completed', controlId, proposalId: proposal.proposalId, stageCount: stages.length, adaptations: clone(updated.adaptations), storeVersion: updated.version });
    await this.#emit('evolution.control.completed', { executionId: controlId, ...result });
    return result;
  }

  async #abort(current, stage, failureResult, rollbackOnFailure, reason = 'stage_failed') {
    const rollbackErrors = [];
    if (rollbackOnFailure) {
      for (const applied of [...current.adaptations].reverse()) {
        try {
          const result = await this.adaptationEngine.rollback(applied.adaptationId);
          if (result.status !== 'rolled_back') rollbackErrors.push({ adaptationId: applied.adaptationId, error: result.error ?? { code: 'ROLLBACK_FAILED', message: 'Adaptation rollback failed' } });
        } catch (error) {
          rollbackErrors.push({ adaptationId: applied.adaptationId, error: normalizeError(error) });
        }
      }
    }
    const status = rollbackErrors.length === 0 && rollbackOnFailure ? 'rolled_back' : 'failed';
    const now = this.clock().toISOString();
    let updated;
    try {
      updated = await this.#update(current, {
        status,
        error: failureResult.error,
        rollbackErrors: clone(rollbackErrors),
        history: [...current.history, { action: reason, status, stageId: stage?.id ?? null, failure: clone(failureResult), rollbackErrors: clone(rollbackErrors), at: now }],
        updatedAt: now
      });
    } catch (error) {
      return Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-control-result', status: 'failed', controlId: current.controlId, proposalId: current.proposalId, stageId: stage?.id ?? null, error: normalizeError(error), rollbackErrors: clone(rollbackErrors) });
    }
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-control-result', status, controlId: current.controlId, proposalId: current.proposalId, stageId: stage?.id ?? null, storeVersion: updated.version, error: failureResult.error, rollbackErrors: clone(rollbackErrors) });
    await this.#emit(status === 'rolled_back' ? 'evolution.control.rolled_back' : 'evolution.control.failed', { executionId: current.controlId, ...result });
    return result;
  }

  async #update(current, patch) { return this.store.update(current.executionId, patch, current.version); }
  async #emit(type, payload) { if (this.eventBus && typeof this.eventBus.emit === 'function') this.eventBus.emit({ ...payload, type }); }
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new TypeError('Evolution proposal must be an object');
  if (proposal.status !== 'accepted') throw new TypeError(`Evolution control requires an accepted proposal: ${proposal.status}`);
  if (typeof proposal.proposalId !== 'string' || !proposal.proposalId.trim()) throw new TypeError('Evolution proposal requires proposalId');
  if (!proposal.metadata || typeof proposal.metadata !== 'object' || Array.isArray(proposal.metadata)) throw new TypeError('Evolution proposal requires metadata');
}
function validateStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) throw new TypeError('Evolution control requires at least one rollout stage');
  const ids = new Set(); let previous = 0;
  for (const stage of stages) {
    if (!stage || typeof stage.id !== 'string' || !stage.id.trim() || ids.has(stage.id)) throw new TypeError('Rollout stages require unique ids');
    if (typeof stage.fraction !== 'number' || !Number.isFinite(stage.fraction) || stage.fraction <= 0 || stage.fraction > 1 || stage.fraction < previous) throw new TypeError('Rollout stage fractions must be increasing numbers in (0, 1]');
    ids.add(stage.id); previous = stage.fraction;
  }
  if (stages.at(-1).fraction !== 1) throw new TypeError('The final rollout stage must have fraction 1');
}
function validateHealth(health) { if (!health || typeof health !== 'object' || typeof health.healthy !== 'boolean') throw new TypeError('Health check must return { healthy: boolean }'); }
function validateContext(context) { if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('Evolution control context must be an object'); }
function validateId(value, name) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`); }
function stateId(controlId) { return `evolution-control:${controlId}`; }
function clone(value) { return structuredClone(value); }
function normalizeError(error) { return { code: error?.code ?? 'EVOLUTION_CONTROL_FAILED', message: error?.message ?? String(error) }; }
function failure(code, message) { return Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-control', status: 'failed', error: Object.freeze({ code, message }) }); }
