const SCHEMA_VERSION = '0.1.0';

export class VerticalMissionEngine {
  constructor({ planner, admission, orchestrator, verifier = null, artifactStore = null, missionStore = null, events = null, clock = () => new Date(), idFactory = defaultMissionId } = {}) {
    if (!planner || typeof planner.plan !== 'function') throw new TypeError('VerticalMissionEngine requires planner');
    if (!admission || typeof admission.admit !== 'function') throw new TypeError('VerticalMissionEngine requires admission');
    if (!orchestrator || typeof orchestrator.execute !== 'function') throw new TypeError('VerticalMissionEngine requires orchestrator');
    if (verifier && typeof verifier.verify !== 'function') throw new TypeError('verifier must expose verify()');
    if (artifactStore && typeof artifactStore.write !== 'function') throw new TypeError('artifactStore must expose write()');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    this.planner = planner; this.admission = admission; this.orchestrator = orchestrator;
    this.verifier = verifier; this.artifactStore = artifactStore; this.missionStore = missionStore; this.events = events;
    this.clock = clock; this.idFactory = idFactory; this.missions = new Map();
  }

  getMission(missionId) { const value = this.missions.get(missionId); return value ? clone(value) : null; }
  listMissions() { return Object.freeze([...this.missions.values()].map(clone)); }

  async execute(request = {}, input = {}, context = {}, options = {}) {
    const missionId = context.missionId ?? this.idFactory(request.goal ?? 'mission');
    const startedAt = this.clock().toISOString();
    const record = { schemaVersion: SCHEMA_VERSION, type: 'vertical-mission', missionId, status: 'planning',
      goal: typeof request.goal === 'string' ? request.goal.trim() : null, startedAt, finishedAt: null,
      plan: null, admission: null, execution: null, verification: null, artifacts: [], report: null };
    this.#store(record);
    this.#emit({ type: 'mission.vertical.started', missionId, status: 'planning', data: { goal: record.goal } });

    try {
      const plan = this.planner.plan({ ...request, context: { ...request.context, ...context } });
      record.plan = clone(plan); await this.#persist(record);
      if (plan.executionDecision?.status !== 'ready') {
        return this.#finish(record, plan.executionDecision?.status === 'blocked' ? 'rejected' : 'failed',
          { code: 'MISSION_PLAN_NOT_READY', message: plan.executionDecision?.reasons?.[0]?.message ?? 'Mission plan is not executable', details: plan.executionDecision?.reasons ?? [] });
      }

      record.status = 'admitting'; await this.#persist(record);
      const admission = this.admission.admit(plan, { ...context, missionId });
      record.admission = clone(admission);
      if (admission.status !== 'ready') {
        return this.#finish(record, admission.status === 'blocked' ? 'rejected' : 'failed',
          { code: 'MISSION_ADMISSION_FAILED', message: admission.reasons?.[0]?.message ?? 'Mission admission failed', details: admission.reasons ?? [] });
      }

      record.status = 'executing'; await this.#persist(record);
      const execution = await this.orchestrator.execute(plan, input, { ...context, missionId }, options);
      record.execution = clone(execution);
      if (execution.status === 'cancelled') return this.#finish(record, 'cancelled', execution.execution?.error ?? { code: 'MISSION_CANCELLED', message: 'Mission execution cancelled' });
      if (execution.status !== 'succeeded') return this.#finish(record, execution.status === 'rejected' ? 'rejected' : 'failed',
        execution.execution?.error ?? { code: 'MISSION_EXECUTION_FAILED', message: 'Mission execution failed' });

      record.status = 'verifying'; await this.#persist(record);
      if (this.verifier) {
        const output = execution.execution?.result?.output ?? execution.execution?.output ?? execution.execution?.result ?? execution;
        record.verification = clone(await this.verifier.verify({ capability: plan, input, output, context: { ...context, missionId, planId: plan.planId, executionId: execution.executionId } }));
        if (!record.verification.verified) return this.#finish(record, 'failed',
          { code: 'MISSION_VERIFICATION_FAILED', message: 'Mission output failed verification', details: record.verification.failures });
      }

      record.status = 'delivering'; await this.#persist(record);
      const payload = { schemaVersion: SCHEMA_VERSION, type: 'mission-artifact', missionId, planId: plan.planId,
        executionId: execution.executionId, goal: plan.goal,
        output: clone(execution.execution?.result?.output ?? execution.execution?.output ?? execution.execution?.result ?? execution),
        verification: clone(record.verification) };
      record.artifacts.push(clone(this.artifactStore
        ? await this.artifactStore.write(payload, { missionId, planId: plan.planId, executionId: execution.executionId })
        : payload));
      return this.#finish(record, 'succeeded', null);
    } catch (error) {
      return this.#finish(record, 'failed', normalizeError(error));
    }
  }

  #finish(record, status, error) {
    record.status = status; record.finishedAt = this.clock().toISOString();
    if (error) record.error = clone(error);
    record.report = freezeDeep({
      schemaVersion: SCHEMA_VERSION, type: 'mission-report', missionId: record.missionId, status, goal: record.goal,
      startedAt: record.startedAt, finishedAt: record.finishedAt, planId: record.plan?.planId ?? null,
      executionId: record.execution?.executionId ?? null, planning: summarize(record.plan?.executionDecision),
      admission: summarize(record.admission),
      execution: record.execution ? { status: record.execution.status, recoveryAttempts: record.execution.recoveryAttempts ?? 0 } : null,
      verification: record.verification ? { verified: record.verification.verified, checks: record.verification.checks, failures: record.verification.failures } : null,
      artifacts: record.artifacts.map(a => ({ type: a.type, missionId: a.missionId, planId: a.planId, executionId: a.executionId })),
      error: error ? clone(error) : null
    });
    this.#store(record);
    this.#emit({ type: status === 'succeeded' ? 'mission.vertical.completed' : 'mission.vertical.failed', missionId: record.missionId, status, data: clone(record.report), error: error ?? undefined });
    return clone(record);
  }

  #store(record) { this.missions.set(record.missionId, structuredClone(record)); }
  async #persist(record) { this.#store(record); if (this.missionStore) await this.missionStore.save(record, record.version ?? null); }
  async recover(missionId) { if (!this.missionStore) return this.getMission(missionId); const record = await this.missionStore.get(missionId); if (record) this.#store(record); return clone(record); }
  #emit(event) { this.events?.emit({ schemaVersion: SCHEMA_VERSION, timestamp: this.clock().toISOString(), ...event }); }
}

function summarize(value) { return value ? { status: value.status ?? null, reasons: clone(value.reasons ?? []) } : null; }
function normalizeError(error) { return { code: error?.code ?? 'MISSION_VERTICAL_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freezeDeep(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freezeDeep(child); return Object.freeze(value); }
function defaultMissionId(goal) { return 'mission-' + Date.now().toString(36) + '-' + String(goal).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32); }

export { SCHEMA_VERSION as VERTICAL_MISSION_SCHEMA_VERSION };
