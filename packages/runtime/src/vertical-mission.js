import { createExecutionId } from './events.js';

export const VERTICAL_MISSION_SCHEMA_VERSION = '0.2.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);

export class VerticalMissionEngine {
  constructor({ taskDecomposer, taskGraphExecutor, missionStore, verifier = null, events = null, artifactStore = null, clock = () => new Date(), idFactory = createExecutionId } = {}) {
    if (!taskDecomposer || typeof taskDecomposer.decompose !== 'function') throw new TypeError('VerticalMissionEngine requires TaskDecomposer');
    if (!taskGraphExecutor || typeof taskGraphExecutor.execute !== 'function' || typeof taskGraphExecutor.resume !== 'function') throw new TypeError('VerticalMissionEngine requires resumable TaskGraphExecutor');
    if (!missionStore || typeof missionStore.save !== 'function' || typeof missionStore.get !== 'function') throw new TypeError('VerticalMissionEngine requires MissionStore');
    if (verifier && typeof verifier.verify !== 'function') throw new TypeError('verifier must expose verify()');
    if (artifactStore && typeof artifactStore.save !== 'function') throw new TypeError('artifactStore must expose save()');
    this.taskDecomposer = taskDecomposer;
    this.taskGraphExecutor = taskGraphExecutor;
    this.missionStore = missionStore;
    this.verifier = verifier;
    this.events = events;
    this.artifactStore = artifactStore;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async execute(mission, input = {}, context = {}, options = {}) {
    validateMission(mission);
    const missionExecutionId = context.executionId ?? this.idFactory(mission.id);
    const plan = this.taskDecomposer.decompose({ goal: mission.goal ?? mission.name ?? mission.id, tasks: mission.tasks });
    const startedAt = this.clock().toISOString();
    let record = await this.missionStore.save({
      schemaVersion: VERTICAL_MISSION_SCHEMA_VERSION,
      type: 'vertical-mission',
      missionId: mission.id,
      missionExecutionId,
      status: 'planning',
      attempt: 1,
      plan,
      input: structuredClone(input),
      context: sanitizeContext(context),
      result: null,
      verification: null,
      artifacts: [],
      startedAt,
      finishedAt: null
    });
    this.#emit('mission.planned', record);
    record = await this.#transition(record, 'executing');

    let execution;
    try {
      execution = await this.taskGraphExecutor.execute(plan, input, { ...context, executionId: missionExecutionId }, options.execution ?? {});
    } catch (error) {
      execution = { status: 'failed', error: normalizeError(error), executionId: missionExecutionId };
    }
    if (execution.status !== 'succeeded') {
      if (isRetryableExecution(execution)) {
        const interrupted = await this.missionStore.save({ ...record, status: 'executing', result: structuredClone(execution), recovery: { status: 'available', resumable: true, reason: 'Task graph failed with a retryable error; unfinished work can be resumed.' } }, record.version);
        this.#emit('mission.recovery.available', interrupted);
        return interrupted;
      }
      return this.#finish(record, 'failed', execution, null);
    }

    record = await this.#transition(record, 'verifying');
    const verification = this.verifier
      ? await this.verifier.verify({ capability: mission, input, output: execution, context: { ...context, missionExecutionId } })
      : { verified: true, checks: 0, failures: [] };
    if (!verification.verified) return this.#finish(record, 'rejected', execution, verification);

    record = await this.#transition(record, 'delivering');
    const artifacts = this.artifactStore ? await this.artifactStore.save({ mission, input, output: execution, missionExecutionId }) : [];
    return this.#finish(record, 'succeeded', execution, verification, artifacts);
  }

  async recover(missionExecutionId, options = {}) {
    const record = await this.missionStore.get(missionExecutionId);
    if (!record) return null;
    if (TERMINAL.has(record.status)) return Object.freeze({ ...record, recovery: { status: 'terminal', resumable: false } });
    if (record.status !== 'executing') {
      return Object.freeze({ ...record, recovery: { status: 'available', resumable: false, reason: 'Mission is not interrupted inside an executable phase' } });
    }
    if (!options.resume) {
      return Object.freeze({ ...record, recovery: { status: 'available', resumable: true, reason: 'Call recover(id, { resume: true }) to resume unfinished task-graph work.' } });
    }

    const current = await this.missionStore.save({ ...record, status: 'recovering', recovery: { status: 'started', resumable: true } }, record.version);
    this.#emit('mission.recovery.started', current);
    let execution;
    try {
      execution = await this.taskGraphExecutor.resume(record.plan, record.missionExecutionId, { ...record.context, executionId: record.missionExecutionId, recovered: true }, { allowRunning: options.allowRunning === true });
    } catch (error) {
      execution = { status: 'failed', error: normalizeError(error), executionId: record.missionExecutionId, resumed: true };
    }
    if (execution.status !== 'succeeded') {
      if (isRetryableExecution(execution)) {
        const retryable = await this.missionStore.save({ ...current, status: 'executing', result: structuredClone(execution), recovery: { status: 'available', resumable: true, reason: 'Recovered execution failed transiently; retry recovery after the underlying task state is safe.' } }, current.version);
        this.#emit('mission.recovery.available', retryable);
        return retryable;
      }
      return this.#finish(current, 'failed', execution, null, [], { recovered: true });
    }

    const verifying = await this.#transition(current, 'verifying');
    const verification = this.verifier
      ? await this.verifier.verify({ capability: { id: record.missionId, kind: 'mission' }, input: record.input, output: execution, context: { ...record.context, missionExecutionId: record.missionExecutionId, recovered: true } })
      : { verified: true, checks: 0, failures: [] };
    if (!verification.verified) return this.#finish(verifying, 'rejected', execution, verification, [], { recovered: true });
    const artifacts = this.artifactStore
      ? await this.artifactStore.save({ mission: { id: record.missionId, kind: 'mission' }, input: record.input, output: execution, missionExecutionId: record.missionExecutionId, recovered: true })
      : [];
    return this.#finish(verifying, 'succeeded', execution, verification, artifacts, { recovered: true });
  }

  async get(missionExecutionId) { return this.missionStore.get(missionExecutionId); }
  async list(filter = {}) { return this.missionStore.list(filter); }

  async #transition(record, status) {
    const next = await this.missionStore.save({ ...record, status }, record.version);
    this.#emit('mission.' + status, next);
    return next;
  }

  async #finish(record, status, execution, verification, artifacts = [], extra = {}) {
    const next = await this.missionStore.save({
      ...record,
      status,
      result: structuredClone(execution),
      verification: verification ? structuredClone(verification) : null,
      artifacts: structuredClone(artifacts),
      finishedAt: this.clock().toISOString(),
      recovery: extra.recovered ? { status: 'completed', resumed: true } : record.recovery ?? null
    }, record.version);
    this.#emit(status === 'succeeded' ? 'mission.completed' : 'mission.failed', next);
    return next;
  }

  #emit(type, record) {
    this.events?.emit({ schemaVersion: VERTICAL_MISSION_SCHEMA_VERSION, type, missionId: record.missionId, missionExecutionId: record.missionExecutionId, status: record.status, data: structuredClone(record) });
  }
}

function validateMission(mission) {
  if (!mission || mission.kind !== 'mission') throw new TypeError('A mission manifest is required');
  if (typeof mission.id !== 'string' || !mission.id) throw new TypeError('Mission requires id');
  if (!Array.isArray(mission.tasks) || mission.tasks.length === 0) throw new TypeError('Vertical mission requires explicit tasks');
}

function sanitizeContext(context) {
  const value = structuredClone(context);
  delete value.signal;
  delete value.abortSignal;
  return value;
}

function isRetryableExecution(execution) {
  if (execution?.error?.retryable) return true;
  return Array.isArray(execution?.results) && execution.results.some((result) => result?.error?.retryable === true);
}

function normalizeError(error) {
  return {
    code: error?.code ?? 'MISSION_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: Boolean(error?.retryable)
  };
}
