import { createExecutionId } from './events.js';
import { ExecutionStateStore } from './state.js';
import { PolicyEngine } from './policy.js';
import { VerificationEngine } from './verification.js';

export class AdaptationEngine {
  constructor({
    adapter,
    store = new ExecutionStateStore(),
    policyEngine = new PolicyEngine(),
    verificationEngine = new VerificationEngine(),
    eventBus = null,
    clock = () => new Date()
  } = {}) {
    if (!adapter || typeof adapter.apply !== 'function' || typeof adapter.rollback !== 'function') {
      throw new TypeError('AdaptationEngine requires an adapter with apply and rollback');
    }
    if (!store || typeof store.create !== 'function' || typeof store.get !== 'function' || typeof store.update !== 'function') {
      throw new TypeError('AdaptationEngine requires a compatible state store');
    }
    if (!policyEngine || typeof policyEngine.authorize !== 'function') {
      throw new TypeError('AdaptationEngine requires a compatible policy engine');
    }
    if (!verificationEngine || typeof verificationEngine.verify !== 'function') {
      throw new TypeError('AdaptationEngine requires a compatible verification engine');
    }
    this.adapter = adapter;
    this.store = store;
    this.policyEngine = policyEngine;
    this.verificationEngine = verificationEngine;
    this.eventBus = eventBus;
    this.clock = clock;
  }

  async get(adaptationId) {
    validateId(adaptationId, 'adaptationId');
    const state = await this.store.get(stateId(adaptationId));
    return state ? clone(state) : null;
  }

  async list(filter = {}) {
    const states = await this.store.list({ type: 'runtime-adaptation', ...filter });
    return states.map(clone);
  }

  async apply(proposal, context = {}, expectedVersion = null) {
    validateProposal(proposal);
    validateContext(context);
    validateExpectedVersion(expectedVersion);
    if (proposal.status !== 'accepted') {
      return failure('ADAPTATION_PROPOSAL_NOT_ACCEPTED', `Evolution proposal is not accepted: ${proposal.status}`);
    }

    const decision = this.policyEngine.authorize(
      { risk: proposal.metadata?.risk ?? 'low', permissions: proposal.metadata?.permissions ?? [] },
      { ...context, evolutionProposal: proposal, adaptation: true }
    );
    if (!decision?.allowed) {
      return failure('ADAPTATION_POLICY_DENIED', decision?.reason ?? 'Adaptation denied by policy');
    }

    const adaptationId = createExecutionId();
    const now = this.clock().toISOString();
    const state = await this.store.create({
      executionId: stateId(adaptationId),
      type: 'runtime-adaptation',
      schemaVersion: '0.1.0',
      adaptationId,
      proposalId: proposal.proposalId,
      status: 'applying',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      history: [{ revision: 1, action: 'apply_started', status: 'applying', at: now }]
    });

    if (expectedVersion !== null && expectedVersion !== state.version) {
      return this.#failApply(state, { code: 'EXECUTION_STATE_CONFLICT', message: `Execution state version conflict: expected ${expectedVersion}, actual ${state.version}` });
    }

    await this.#emit('adaptation.started', { executionId: adaptationId, adaptationId, proposalId: proposal.proposalId });

    let applied;
    try {
      applied = await this.adapter.apply({ proposal: clone(proposal), context: clone(context), adaptationId });
    } catch (error) {
      return this.#failApply(state, normalizeError(error));
    }

    if (!applied || typeof applied !== 'object' || typeof applied.rollback !== 'function') {
      return this.#failApply(state, { code: 'ADAPTER_CONTRACT_INVALID', message: 'Adapter apply must return an object with rollback function' });
    }

    let verification;
    try {
      verification = await this.verificationEngine.verify({
        capability: proposal.metadata?.capability ?? { id: proposal.suiteId, risk: proposal.metadata?.risk ?? 'low' },
        input: proposal.metadata?.input ?? null,
        output: applied.output,
        context: { ...context, adaptationId, evolutionProposal: proposal }
      });
    } catch (error) {
      return this.#rollbackAfterFailure(state, applied, 'Verification threw an error', null, normalizeError(error));
    }

    if (!verification.verified) {
      return this.#rollbackAfterFailure(state, applied, 'Verification failed', verification, null);
    }

    const finishedAt = this.clock().toISOString();
    const nextRevision = state.revision + 1;
    let updated;
    try {
      updated = await this.store.update(state.executionId, {
        status: 'applied',
        revision: nextRevision,
        output: clone(applied.output),
        verification: clone(verification),
        history: [...state.history, { revision: nextRevision, action: 'applied', status: 'applied', at: finishedAt }],
        updatedAt: finishedAt
      }, expectedVersion);
    } catch (error) {
      const normalized = normalizeError(error);
      try {
        await applied.rollback({ reason: 'State commit failed', error: normalized, adaptationId });
      } catch (rollbackError) {
        return this.#failVerificationRollback(state, verification, {
          code: 'ADAPTATION_COMMIT_AND_ROLLBACK_FAILED',
          message: `${normalized.message}; rollback failed: ${normalizeError(rollbackError).message}`
        });
      }
      return this.#failVerificationRollback(state, verification, normalized);
    }

    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'adaptation-result', status: 'applied', adaptationId, proposalId: proposal.proposalId, revision: updated.revision, storeVersion: updated.version, output: clone(applied.output), verification: clone(verification) });
    await this.#emit('adaptation.completed', { executionId: adaptationId, ...result });
    return result;
  }

  async rollback(adaptationId, expectedVersion = null) {
    validateId(adaptationId, 'adaptationId');
    validateExpectedVersion(expectedVersion);
    const current = await this.store.get(stateId(adaptationId));
    if (!current) return failure('ADAPTATION_NOT_FOUND', `Runtime adaptation not found: ${adaptationId}`);
    if (current.status !== 'applied') return failure('ADAPTATION_NOT_APPLIED', `Runtime adaptation is not applied: ${current.status}`);
    if (expectedVersion !== null && expectedVersion !== current.version) {
      return failure('EXECUTION_STATE_CONFLICT', `Execution state version conflict: expected ${expectedVersion}, actual ${current.version}`);
    }

    try {
      await this.adapter.rollback({ adaptation: clone(current), adaptationId });
    } catch (error) {
      return failure('ADAPTATION_ROLLBACK_FAILED', normalizeError(error).message);
    }

    const now = this.clock().toISOString();
    const nextRevision = current.revision + 1;
    let updated;
    try {
      updated = await this.store.update(stateId(adaptationId), {
        status: 'rolled_back',
        revision: nextRevision,
        history: [...current.history, { revision: nextRevision, action: 'rollback', status: 'rolled_back', fromRevision: current.revision, at: now }],
        updatedAt: now
      }, expectedVersion);
    } catch (error) {
      return failure(normalizeError(error).code, normalizeError(error).message);
    }
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'adaptation-rollback', status: 'rolled_back', adaptationId, previousRevision: current.revision, revision: updated.revision, storeVersion: updated.version });
    await this.#emit('adaptation.rolled_back', { executionId: adaptationId, ...result });
    return result;
  }

  async #rollbackAfterFailure(state, applied, reason, verification, error) {
    try {
      await applied.rollback({ reason, verification, error, adaptationId: state.adaptationId });
    } catch (rollbackError) {
      return this.#failVerificationRollback(state, verification, {
        code: 'ADAPTATION_ROLLBACK_FAILED',
        message: normalizeError(rollbackError).message
      });
    }
    const now = this.clock().toISOString();
    const revision = state.revision + 1;
    const updated = await this.store.update(state.executionId, {
      status: 'rolled_back',
      revision,
      verification,
      error: error ?? undefined,
      history: [...state.history, { revision, action: 'rollback_after_verification_failure', status: 'rolled_back', reason, at: now, verification, error: error ?? undefined }],
      updatedAt: now
    });
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'adaptation-result', status: 'rolled_back', adaptationId: state.adaptationId, proposalId: state.proposalId, revision: updated.revision, storeVersion: updated.version, verification, error: error ?? undefined });
    await this.#emit('adaptation.rolled_back', { executionId: state.adaptationId, ...result, reason });
    return result;
  }

  async #failApply(state, error) {
    const now = this.clock().toISOString();
    const revision = state.revision + 1;
    const updated = await this.store.update(state.executionId, {
      status: 'failed',
      revision,
      error,
      history: [...state.history, { revision, action: 'apply_failed', status: 'failed', error, at: now }],
      updatedAt: now
    });
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'adaptation-result', status: 'failed', adaptationId: state.adaptationId, proposalId: state.proposalId, revision: updated.revision, storeVersion: updated.version, error });
    await this.#emit('adaptation.failed', { executionId: state.adaptationId, ...result });
    return result;
  }

  async #failVerificationRollback(state, verification, error) {
    const now = this.clock().toISOString();
    const revision = state.revision + 1;
    const updated = await this.store.update(state.executionId, {
      status: 'failed',
      revision,
      verification,
      error,
      history: [...state.history, { revision, action: 'verification_failed_rollback_failed', status: 'failed', verification, error, at: now }],
      updatedAt: now
    });
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'adaptation-result', status: 'failed', adaptationId: state.adaptationId, proposalId: state.proposalId, revision: updated.revision, storeVersion: updated.version, verification, error });
    await this.#emit('adaptation.failed', { executionId: state.adaptationId, ...result });
    return result;
  }

  async #emit(type, payload) {
    if (this.eventBus && typeof this.eventBus.emit === 'function') this.eventBus.emit({ ...payload, type });
  }
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new TypeError('Evolution proposal must be an object');
  if (typeof proposal.proposalId !== 'string' || !proposal.proposalId.trim()) throw new TypeError('Evolution proposal requires proposalId');
  if (typeof proposal.suiteId !== 'string' || !proposal.suiteId.trim()) throw new TypeError('Evolution proposal requires suiteId');
  if (!proposal.metadata || typeof proposal.metadata !== 'object' || Array.isArray(proposal.metadata)) throw new TypeError('Evolution proposal requires metadata');
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('Adaptation context must be an object');
}

function validateExpectedVersion(value) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) throw new TypeError('expectedVersion must be a non-negative integer or null');
}

function validateId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
}

function stateId(adaptationId) { return `runtime-adaptation:${adaptationId}`; }
function clone(value) { return structuredClone(value); }
function normalizeError(error) { return { code: error?.code ?? 'ADAPTATION_FAILED', message: error?.message ?? String(error) }; }
function failure(code, message) { return Object.freeze({ schemaVersion: '0.1.0', type: 'adaptation', status: 'failed', error: Object.freeze({ code, message }) }); }
