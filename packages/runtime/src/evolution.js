import { createExecutionId } from './events.js';
import { ExecutionStateStore } from './state.js';
import { PolicyEngine } from './policy.js';

export class EvolutionEngine {
  constructor({ store = new ExecutionStateStore(), policyEngine = new PolicyEngine(), eventBus = null, clock = () => new Date() } = {}) {
    if (!store || typeof store.create !== 'function' || typeof store.get !== 'function' || typeof store.update !== 'function') throw new TypeError('EvolutionEngine requires a compatible state store');
    if (!policyEngine || typeof policyEngine.authorize !== 'function') throw new TypeError('EvolutionEngine requires a compatible policy engine');
    this.store = store;
    this.policyEngine = policyEngine;
    this.eventBus = eventBus;
    this.clock = clock;
  }

  async get(proposalId) {
    validateProposalId(proposalId);
    const state = await this.store.get(stateId(proposalId));
    return state ? clone(state) : null;
  }

  async list(filter = {}) {
    const states = await this.store.list({ type: 'evolution-proposal', ...filter });
    return states.map(clone);
  }

  async propose(evaluationRun, metadata = {}) {
    validateEvaluation(evaluationRun);
    validateMetadata(metadata);
    const proposalId = createExecutionId();
    const now = this.clock().toISOString();
    const signals = deriveSignals(evaluationRun);
    const proposal = {
      proposalId,
      sourceEvaluationId: evaluationRun.evaluationId ?? null,
      suiteId: evaluationRun.suiteId,
      status: signals.length === 0 ? 'no_change' : 'proposed',
      revision: 1,
      signals,
      metadata: clone(metadata),
      history: [{ revision: 1, action: 'proposed', status: signals.length === 0 ? 'no_change' : 'proposed', signals: clone(signals), at: now }],
      createdAt: now,
      updatedAt: now
    };
    const state = await this.store.create({ executionId: stateId(proposalId), type: 'evolution-proposal', schemaVersion: '0.1.0', ...proposal });
    await this.#emit('evolution.proposal.created', state);
    return clone(state);
  }

  async accept(proposalId, context = {}, expectedVersion = null) {
    validateProposalId(proposalId);
    validateExpectedVersion(expectedVersion);
    const current = await this.store.get(stateId(proposalId));
    if (!current) return failure('EVOLUTION_PROPOSAL_NOT_FOUND', `Evolution proposal not found: ${proposalId}`);
    if (current.status !== 'proposed') return failure('EVOLUTION_PROPOSAL_NOT_ELIGIBLE', `Evolution proposal is not eligible for acceptance: ${current.status}`);
    const decision = this.policyEngine.authorize({ risk: current.metadata.risk ?? 'low', permissions: current.metadata.permissions ?? [] }, { ...context, evolutionProposal: current });
    if (!decision?.allowed) {
      await this.#emit('evolution.proposal.rejected', { proposalId, revision: current.revision, reason: decision?.reason ?? 'Denied by policy' });
      return Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-decision', status: 'rejected', proposalId, revision: current.revision, reason: decision?.reason ?? 'Denied by policy' });
    }
    const now = this.clock().toISOString();
    const nextRevision = current.revision + 1;
    const updated = await this.store.update(stateId(proposalId), {
      revision: nextRevision,
      status: 'accepted',
      history: [...current.history, { revision: nextRevision, action: 'accepted', status: 'accepted', at: now }],
      updatedAt: now
    }, expectedVersion);
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-decision', status: 'accepted', proposalId, revision: updated.revision, storeVersion: updated.version, signals: clone(updated.signals) });
    await this.#emit('evolution.proposal.accepted', result);
    return result;
  }

  async reject(proposalId, reason = 'Rejected by governance', expectedVersion = null) {
    validateProposalId(proposalId);
    if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('Rejection reason must be a non-empty string');
    validateExpectedVersion(expectedVersion);
    const current = await this.store.get(stateId(proposalId));
    if (!current) return failure('EVOLUTION_PROPOSAL_NOT_FOUND', `Evolution proposal not found: ${proposalId}`);
    if (current.status !== 'proposed') return failure('EVOLUTION_PROPOSAL_NOT_ELIGIBLE', `Evolution proposal is not eligible for rejection: ${current.status}`);
    const now = this.clock().toISOString();
    const nextRevision = current.revision + 1;
    const updated = await this.store.update(stateId(proposalId), {
      revision: nextRevision,
      status: 'rejected',
      history: [...current.history, { revision: nextRevision, action: 'rejected', status: 'rejected', reason, at: now }],
      updatedAt: now
    }, expectedVersion);
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-decision', status: 'rejected', proposalId, revision: updated.revision, storeVersion: updated.version, reason });
    await this.#emit('evolution.proposal.rejected', result);
    return result;
  }

  async rollback(proposalId, targetRevision, expectedVersion = null) {
    validateProposalId(proposalId);
    if (!Number.isInteger(targetRevision) || targetRevision < 1) throw new TypeError('targetRevision must be a positive integer');
    validateExpectedVersion(expectedVersion);
    const current = await this.store.get(stateId(proposalId));
    if (!current) return failure('EVOLUTION_PROPOSAL_NOT_FOUND', `Evolution proposal not found: ${proposalId}`);
    const target = current.history.find((entry) => entry.revision === targetRevision);
    if (!target) return failure('EVOLUTION_REVISION_NOT_FOUND', `Evolution proposal revision ${targetRevision} does not exist`);
    const now = this.clock().toISOString();
    const nextRevision = current.revision + 1;
    const updated = await this.store.update(stateId(proposalId), {
      revision: nextRevision,
      status: target.status,
      history: [...current.history, { revision: nextRevision, action: 'rollback', status: target.status, fromRevision: current.revision, targetRevision, at: now }],
      updatedAt: now
    }, expectedVersion);
    const result = Object.freeze({ schemaVersion: '0.1.0', type: 'evolution-rollback', status: 'rolled_back', proposalId, previousRevision: current.revision, revision: updated.revision, storeVersion: updated.version, targetRevision, restoredStatus: target.status });
    await this.#emit('evolution.proposal.rolled_back', result);
    return result;
  }

  async #emit(type, payload) {
    if (this.eventBus && typeof this.eventBus.emit === 'function') this.eventBus.emit({ ...payload, type });
  }
}

function deriveSignals(evaluation) {
  const failures = evaluation.results.filter((result) => result.status === 'failed');
  const groups = new Map();
  for (const result of failures) {
    const failedAssertions = (result.assertions ?? []).filter((assertion) => assertion.ok === false).map((assertion) => assertion.name).sort();
    const key = `${result.capabilityId}:${failedAssertions.join(',')}`;
    const existing = groups.get(key) ?? { capabilityId: result.capabilityId, assertionNames: failedAssertions, caseIds: [] };
    existing.caseIds.push(result.caseId);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => `${a.capabilityId}:${a.assertionNames.join(',')}`.localeCompare(`${b.capabilityId}:${b.assertionNames.join(',')}`)).map((signal) => Object.freeze({
    kind: 'failure-pattern',
    capabilityId: signal.capabilityId,
    assertionNames: Object.freeze([...signal.assertionNames]),
    caseIds: Object.freeze([...signal.caseIds].sort()),
    occurrenceCount: signal.caseIds.length,
    action: 'investigate-and-improve'
  }));
}

function validateEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw new TypeError('Evaluation run must be an object');
  if (evaluation.type !== 'evaluation-run') throw new TypeError('Evaluation run requires type evaluation-run');
  if (typeof evaluation.suiteId !== 'string' || !evaluation.suiteId.trim()) throw new TypeError('Evaluation run requires suiteId');
  if (!Array.isArray(evaluation.results)) throw new TypeError('Evaluation run requires results');
  for (const result of evaluation.results) {
    if (!result || typeof result.caseId !== 'string' || !result.caseId.trim()) throw new TypeError('Evaluation results require caseId');
    if (typeof result.capabilityId !== 'string' || !result.capabilityId.trim()) throw new TypeError(`Evaluation result ${result.caseId} requires capabilityId`);
    if (result.status !== 'passed' && result.status !== 'failed') throw new TypeError(`Evaluation result ${result.caseId} requires passed or failed status`);
  }
}

function validateProposalId(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('proposalId must be a non-empty string'); }
function validateExpectedVersion(value) { if (value !== null && (!Number.isInteger(value) || value < 0)) throw new TypeError('expectedVersion must be a non-negative integer or null'); }
function validateMetadata(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Evolution metadata must be an object'); }
function stateId(proposalId) { return `evolution-proposal:${proposalId}`; }
function failure(code, message) { return Object.freeze({ schemaVersion: '0.1.0', type: 'evolution', status: 'failed', error: Object.freeze({ code, message }) }); }
function clone(value) { return structuredClone(value); }
