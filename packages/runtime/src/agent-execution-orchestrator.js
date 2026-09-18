const SCHEMA_VERSION = '0.1.0';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);

export class AgentExecutionOrchestrator {
  constructor({ admission, runtimeAdmission = null, reflection = null, recovery = null, events = null, clock = () => new Date(), maxRecoveryAttempts = 0, idFactory = defaultSessionId } = {}) {
    if (!admission || typeof admission.admit !== 'function' || typeof admission.execute !== 'function') {
      throw new TypeError('AgentExecutionOrchestrator requires AgentExecutionAdmission');
    }
    if (runtimeAdmission && typeof runtimeAdmission.execute !== 'function') throw new TypeError('runtimeAdmission must expose execute()');
    if (reflection && typeof reflection.evaluate !== 'function') throw new TypeError('reflection must expose evaluate()');
    if (recovery && typeof recovery.recover !== 'function') throw new TypeError('recovery must expose recover()');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 0) throw new TypeError('maxRecoveryAttempts must be a non-negative integer');
    this.admission = admission;
    this.runtimeAdmission = runtimeAdmission;
    this.reflection = reflection;
    this.recovery = recovery;
    this.events = events;
    this.clock = clock;
    this.maxRecoveryAttempts = maxRecoveryAttempts;
    this.idFactory = idFactory;
    this.sessions = new Map();
  }

  getSession(executionId) {
    const session = this.sessions.get(executionId);
    return session ? clone(session) : null;
  }

  listSessions() {
    return Object.freeze([...this.sessions.values()].map(clone));
  }

  cancel(executionId, reason = 'Agent execution cancelled') {
    const cancel = this.admission.taskGraphExecutor?.cancel;
    if (typeof cancel !== 'function') return false;
    return cancel.call(this.admission.taskGraphExecutor, executionId, reason);
  }

  async execute(plan, input = {}, context = {}, options = {}) {
    const admission = this.admission.admit(plan, context);
    if (admission.status !== 'ready') {
      return this.#recordRejected(plan, admission, context);
    }

    const executionId = context.executionId ?? this.idFactory(plan.planId);
    const correlationId = context.correlationId ?? executionId;
    const startedAt = this.clock().toISOString();
    const session = {
      schemaVersion: SCHEMA_VERSION,
      type: 'agent-execution-session',
      executionId,
      correlationId,
      planId: plan.planId,
      status: 'admitted',
      attempt: 0,
      recoveryAttempts: 0,
      startedAt,
      finishedAt: null,
      history: [{ status: 'admitted', timestamp: startedAt }]
    };
    this.#store(session);
    this.#emit({ type: 'agent.orchestration.admitted', executionId, planId: plan.planId, status: 'admitted', data: { admission } });

    let result = await this.#runAttempt(plan, input, context, options, session, executionId, correlationId);
    let recoveryAttempts = 0;
    while (result.status === 'failed' && isRetryable(result) && this.recovery && recoveryAttempts < this.maxRecoveryAttempts) {
      recoveryAttempts += 1;
      this.#transition(executionId, 'recovering', { recoveryAttempt: recoveryAttempts });
      this.#emit({ type: 'agent.orchestration.recovery.started', executionId, planId: plan.planId, status: 'recovering', data: { recoveryAttempt: recoveryAttempts } });
      try {
        const recovered = await this.recovery.recover(toTaskPlan(plan), executionId, { ...context, executionId, correlationId }, { allowRunning: true });
        result = normalizeExecutionResult(recovered, executionId);
        this.#transition(executionId, result.status === 'succeeded' ? 'running' : result.status === 'cancelled' ? 'cancelled' : 'failed', { recoveryAttempt: recoveryAttempts });
        this.#emit({ type: result.status === 'succeeded' ? 'agent.orchestration.recovery.completed' : 'agent.orchestration.recovery.failed', executionId, planId: plan.planId, status: result.status, data: { recoveryAttempt: recoveryAttempts, result } });
      } catch (error) {
        result = { status: 'failed', error: normalizeError(error) };
        break;
      }
    }

    const reflection = await this.#reflect(plan, result, { ...context, executionId, correlationId });
    const finalStatus = result.status === 'cancelled'
      ? 'cancelled'
      : result.status !== 'succeeded'
        ? 'failed'
        : reflection?.status === 'rejected'
          ? 'rejected'
          : 'succeeded';
    const finishedAt = this.clock().toISOString();
    this.#transition(executionId, finalStatus, { reflection, recoveryAttempts, finishedAt });
    const output = freezeDeep({
      schemaVersion: SCHEMA_VERSION,
      type: 'agent-execution-orchestration',
      executionId,
      correlationId,
      planId: plan.planId,
      status: finalStatus,
      attempt: session.attempt,
      recoveryAttempts,
      startedAt,
      finishedAt,
      execution: clone(result),
      reflection: clone(reflection),
      session: this.getSession(executionId)
    });
    this.#emit({ type: finalStatus === 'succeeded' ? 'agent.orchestration.completed' : finalStatus === 'cancelled' ? 'agent.orchestration.cancelled' : 'agent.orchestration.failed', executionId, planId: plan.planId, status: finalStatus, data: output, error: result.error });
    return output;
  }

  async #runAttempt(plan, input, context, options, session, executionId, correlationId) {
    session.attempt += 1;
    this.#transition(executionId, 'running', { attempt: session.attempt });
    this.#emit({ type: 'agent.orchestration.execution.started', executionId, planId: plan.planId, status: 'running', data: { attempt: session.attempt } });
    try {
      const execute = () => this.admission.execute(plan, input, { ...context, executionId, correlationId }, options);
      if (!this.runtimeAdmission) return normalizeExecutionResult(await execute(), executionId);
      const runtimeResult = await this.runtimeAdmission.execute({
        executionId,
        resources: options.resourceRequest ?? context.resourceRequest ?? {},
        metadata: options.admissionMetadata ?? context.admissionMetadata ?? { planId: plan.planId, correlationId },
        signal: context.signal,
        handler: async () => execute()
      });
      if (runtimeResult.status !== 'succeeded') {
        return normalizeExecutionResult({ executionId, status: runtimeResult.status, error: runtimeResult.error, result: runtimeResult.result }, executionId);
      }
      return normalizeExecutionResult(runtimeResult.result, executionId);
    } catch (error) {
      return { executionId, status: 'failed', error: normalizeError(error) };
    }
  }

  async #reflect(plan, result, context) {
    if (!this.reflection) return null;
    this.#transition(context.executionId, 'reflecting');
    this.#emit({ type: 'agent.orchestration.reflection.started', executionId: context.executionId, planId: plan.planId, status: 'reflecting' });
    try {
      const value = await this.reflection.evaluate({ request: { goal: plan.goal }, plan, result, context });
      this.#emit({ type: 'agent.orchestration.reflection.completed', executionId: context.executionId, planId: plan.planId, status: value.status, data: value });
      return value;
    } catch (error) {
      const value = { schemaVersion: SCHEMA_VERSION, type: 'reflection-result', status: 'rejected', evaluations: [], summary: { critics: 0, rejected: 1, warnings: 0 }, error: normalizeError(error) };
      this.#emit({ type: 'agent.orchestration.reflection.failed', executionId: context.executionId, planId: plan.planId, status: 'rejected', error: value.error, data: value });
      return value;
    }
  }

  #recordRejected(plan, admission, context) {
    const executionId = context.executionId ?? this.idFactory(plan?.planId ?? 'invalid');
    const timestamp = this.clock().toISOString();
    const status = admission.status === 'blocked' ? 'failed' : 'rejected';
    const session = {
      schemaVersion: SCHEMA_VERSION,
      type: 'agent-execution-session',
      executionId,
      correlationId: context.correlationId ?? executionId,
      planId: plan?.planId ?? null,
      status,
      attempt: 0,
      recoveryAttempts: 0,
      startedAt: timestamp,
      finishedAt: timestamp,
      history: [{ status, timestamp }],
      admission: clone(admission)
    };
    this.#store(session);
    this.#emit({ type: status === 'failed' ? 'agent.orchestration.blocked' : 'agent.orchestration.rejected', executionId, planId: plan?.planId ?? null, status, data: { admission } });
    return freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'agent-execution-orchestration', executionId, correlationId: session.correlationId, planId: session.planId, status, attempt: 0, recoveryAttempts: 0, startedAt: timestamp, finishedAt: timestamp, execution: null, reflection: null, admission: clone(admission), session: clone(session) });
  }

  #transition(executionId, status, data = {}) {
    const session = this.sessions.get(executionId);
    if (!session) return;
    if (TERMINAL.has(session.status)) return;
    const timestamp = this.clock().toISOString();
    session.status = status;
    session.history.push({ status, timestamp, ...clone(data) });
    if (TERMINAL.has(status)) session.finishedAt = data.finishedAt ?? timestamp;
    this.#store(session);
  }

  #store(session) {
    this.sessions.set(session.executionId, structuredClone(session));
  }

  #emit(event) {
    this.events?.emit({ schemaVersion: SCHEMA_VERSION, timestamp: this.clock().toISOString(), ...event });
  }
}

function toTaskPlan(plan) {
  return { schemaVersion: SCHEMA_VERSION, type: 'task-plan', createdAt: plan.createdAt, goal: plan.goal, taskCount: plan.graph.taskCount, tasks: plan.graph.tasks, order: plan.graph.order };
}

function normalizeExecutionResult(result, executionId) {
  if (!result || typeof result !== 'object') return { executionId, status: 'failed', error: { code: 'EXECUTION_RESULT_INVALID', message: 'Execution returned an invalid result', retryable: false } };
  return { executionId: result.executionId ?? executionId, ...result };
}

function isRetryable(result) {
  return Boolean(result?.error?.retryable || result?.execution?.error?.retryable || result?.result?.error?.retryable);
}

function normalizeError(error) {
  return { code: error?.code ?? 'AGENT_ORCHESTRATION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freezeDeep(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freezeDeep(child); return Object.freeze(value); }
function defaultSessionId(planId) { return `agent-session-${planId}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as AGENT_EXECUTION_ORCHESTRATION_SCHEMA_VERSION };
