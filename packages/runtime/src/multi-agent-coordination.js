const SCHEMA_VERSION = '0.1.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const PARTICIPANT_STATES = new Set(['pending', 'ready', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']);

export class MultiAgentCoordinationKernel {
  constructor({ delegation, handoff = null, sharedContext = null, events = null, cancellation = null, clock = () => new Date(), maxConcurrency = 4, maxContextRetries = 3, idFactory = defaultExecutionId } = {}) {
    if (!delegation || typeof delegation.delegate !== 'function') throw new TypeError('MultiAgentCoordinationKernel requires DelegationEngine');
    if (handoff && typeof handoff.create !== 'function') throw new TypeError('handoff must expose create()');
    if (sharedContext && typeof sharedContext.snapshot !== 'function' || sharedContext && typeof sharedContext.commit !== 'function') throw new TypeError('sharedContext must expose snapshot() and commit()');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (cancellation && typeof cancellation.register !== 'function' || cancellation && typeof cancellation.cancel !== 'function') throw new TypeError('cancellation must expose register() and cancel()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new TypeError('maxConcurrency must be a positive integer');
    if (!Number.isInteger(maxContextRetries) || maxContextRetries < 0) throw new TypeError('maxContextRetries must be a non-negative integer');
    this.delegation = delegation;
    this.handoff = handoff;
    this.sharedContext = sharedContext;
    this.events = events;
    this.cancellation = cancellation;
    this.clock = clock;
    this.maxConcurrency = maxConcurrency;
    this.maxContextRetries = maxContextRetries;
    this.idFactory = idFactory;
    this.sessions = new Map();
  }

  getSession(executionId) {
    const session = this.sessions.get(executionId);
    return session ? clone(session) : null;
  }

  listSessions() { return Object.freeze([...this.sessions.values()].map(clone)); }

  cancel(executionId, reason = 'Multi-agent coordination cancelled') {
    return this.cancellation?.cancel(executionId, reason) ?? false;
  }

  async execute({ teamId = 'team', task = teamId, members, input = {}, context = {}, sharedContext = this.sharedContext, strategy = 'parallel', maxConcurrency = this.maxConcurrency, failFast = true } = {}) {
    const participants = normalizeMembers(members);
    const executionId = context.executionId ?? this.idFactory(teamId);
    const correlationId = context.correlationId ?? executionId;
    const startedAt = this.clock().toISOString();
    const session = { schemaVersion: SCHEMA_VERSION, type: 'multi-agent-coordination-session', executionId, correlationId, teamId, task, status: 'pending', startedAt, finishedAt: null, participants: participants.map((member) => ({ id: member.id, agent: member.agent, status: 'pending', dependsOn: member.dependsOn })) };
    this.#store(session);
    this.#emit({ type: 'multi-agent.coordination.started', executionId, correlationId, teamId, status: 'pending', data: { participantCount: participants.length } });

    if (!participants.length) return this.#finish(executionId, 'failed', { code: 'TEAM_EMPTY', message: 'Coordination requires at least one participant', retryable: false });
    const contextStore = sharedContext ?? new SharedContextAdapter(context, this.clock);
    const controller = new AbortController();
    let cancellationPromise = null;
    if (this.cancellation) {
      try { cancellationPromise = this.cancellation.register(executionId, controller); }
      catch (error) { return this.#finish(executionId, 'failed', normalizeError(error)); }
    }

    try {
      session.status = 'running';
      this.#store(session);
      const results = new Map();
      const pending = new Set(participants.map((member) => member.id));
      const concurrency = Math.max(1, Math.min(Number(maxConcurrency) || 1, participants.length));
      const parallel = strategy === 'parallel';
      if (strategy !== 'parallel' && strategy !== 'sequential') throw coordinationFailure('COORDINATION_STRATEGY_INVALID', `Unsupported coordination strategy: ${strategy}`);

      while (pending.size) {
        if (controller.signal.aborted) throw controller.signal.reason ?? coordinationFailure('EXECUTION_CANCELLED', 'Coordination cancelled');
        const ready = participants.filter((member) => pending.has(member.id) && member.dependsOn.every((dependency) => results.has(dependency)));
        if (!ready.length) throw coordinationFailure('COORDINATION_STALLED', 'Participant dependency graph could not make progress');
        const blocked = ready.filter((member) => member.dependsOn.some((dependency) => results.get(dependency)?.status !== 'succeeded'));
        for (const member of blocked) {
          pending.delete(member.id);
          const result = { id: member.id, agent: member.agent, status: 'blocked', error: { code: 'PARTICIPANT_DEPENDENCY_FAILED', message: `Participant dependency failed: ${member.id}`, retryable: false } };
          results.set(member.id, result);
          this.#updateParticipant(executionId, member.id, 'blocked');
        }
        const executable = ready.filter((member) => !blocked.includes(member));
        if (!executable.length) break;
        const batch = parallel ? executable.slice(0, concurrency) : executable.slice(0, 1);
        batch.forEach((member) => pending.delete(member.id));
        const batchResults = await Promise.all(batch.map((member) => this.#runParticipant({ member, teamId, task, input, context, executionId, correlationId, contextStore, controller, cancellationPromise })));
        batchResults.forEach((result) => results.set(result.id, result));
        if (failFast && batchResults.some((result) => result.status !== 'succeeded')) break;
      }
      for (const member of participants) if (!results.has(member.id)) {
        results.set(member.id, { id: member.id, agent: member.agent, status: controller.signal.aborted ? 'cancelled' : 'cancelled', error: { code: controller.signal.aborted ? 'EXECUTION_CANCELLED' : 'COORDINATION_FAIL_FAST', message: `Participant was not started: ${member.id}`, retryable: false } });
        this.#updateParticipant(executionId, member.id, results.get(member.id).status);
      }
      const ordered = participants.map((member) => results.get(member.id));
      const status = controller.signal.aborted ? 'cancelled' : ordered.every((result) => result.status === 'succeeded') ? 'succeeded' : 'failed';
      return this.#finish(executionId, status, status === 'failed' ? { code: 'PARTICIPANT_FAILED', message: 'One or more participants did not succeed', retryable: false } : undefined, { strategy, maxConcurrency: concurrency, results: ordered, context: contextStore.snapshot() });
    } catch (error) {
      const normalized = normalizeError(error);
      return this.#finish(executionId, normalized.code === 'EXECUTION_CANCELLED' || controller.signal.aborted ? 'cancelled' : 'failed', normalized, { strategy, results: [...session.participants], context: contextStore.snapshot() });
    } finally {
      this.cancellation?.unregister(executionId);
    }
  }

  async #runParticipant({ member, teamId, task, input, context, executionId, correlationId, contextStore, controller, cancellationPromise }) {
    this.#updateParticipant(executionId, member.id, 'running');
    const snapshot = contextStore.snapshot();
    this.#emit({ type: 'multi-agent.participant.started', executionId, correlationId, teamId, participantId: member.id, status: 'running', data: { agent: member.agent, contextVersion: snapshot.version } });
    if (controller.signal.aborted) return { id: member.id, agent: member.agent, status: 'cancelled', error: { code: 'EXECUTION_CANCELLED', message: 'Coordination cancelled', retryable: false } };
    try {
      const handoff = this.handoff?.create({ fromAgent: teamId, toAgent: member.agent, task: member.task ?? task, input: member.input ?? input, context: { ...context, sharedContext: snapshot.values }, metadata: { coordinationId: executionId, participantId: member.id } });
      const delegated = await Promise.race([
        this.delegation.delegate({ fromAgent: teamId, toAgent: member.agent, task: member.task ?? task, input: member.input ?? input, context: { ...context, executionId, correlationId, signal: controller.signal, sharedContext: snapshot.values }, state: { coordinationId: executionId, participantId: member.id, contextVersion: snapshot.version } }),
        ...(cancellationPromise ? [cancellationPromise] : [])
      ]);
      const result = { id: member.id, agent: member.agent, status: delegated.status === 'succeeded' ? 'succeeded' : delegated.status === 'cancelled' ? 'cancelled' : 'failed', task: member.task ?? task, handoff: clone(handoff), result: clone(delegated.result ?? delegated), error: clone(delegated.error) };
      if (result.status === 'succeeded') this.#commitResult(contextStore, member, result, snapshot.version);
      this.#updateParticipant(executionId, member.id, result.status);
      this.#emit({ type: result.status === 'succeeded' ? 'multi-agent.participant.completed' : 'multi-agent.participant.failed', executionId, correlationId, teamId, participantId: member.id, status: result.status, data: result, error: result.error });
      return result;
    } catch (error) {
      const result = { id: member.id, agent: member.agent, status: error?.code === 'EXECUTION_CANCELLED' ? 'cancelled' : 'failed', error: normalizeError(error) };
      this.#updateParticipant(executionId, member.id, result.status);
      this.#emit({ type: result.status === 'cancelled' ? 'multi-agent.participant.cancelled' : 'multi-agent.participant.failed', executionId, correlationId, teamId, participantId: member.id, status: result.status, error: result.error, data: result });
      return result;
    }
  }

  #commitResult(contextStore, member, result, expectedVersion) {
    const patch = { [`participant:${member.id}`]: { agent: member.agent, status: result.status, output: result.result?.result ?? result.result ?? null } };
    let version = expectedVersion;
    for (let attempt = 0; attempt <= this.maxContextRetries; attempt += 1) {
      try { contextStore.commit(patch, { expectedVersion: version, actor: member.agent, reason: 'participant-result' }); return; }
      catch (error) {
        if (error.code !== 'CONTEXT_VERSION_CONFLICT' || attempt === this.maxContextRetries) throw error;
        version = contextStore.snapshot().version;
      }
    }
  }

  #updateParticipant(executionId, participantId, status) {
    if (!PARTICIPANT_STATES.has(status)) throw coordinationFailure('PARTICIPANT_STATE_INVALID', `Invalid participant state: ${status}`);
    const session = this.sessions.get(executionId);
    if (!session) return;
    const participant = session.participants.find((entry) => entry.id === participantId);
    if (participant) participant.status = status;
    this.#store(session);
  }

  #finish(executionId, status, error, extra = {}) {
    const session = this.sessions.get(executionId);
    if (!session) return freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'multi-agent-coordination', executionId, status, error, ...extra });
    if (TERMINAL.has(session.status)) return freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'multi-agent-coordination', executionId, status: session.status, finishedAt: session.finishedAt, ...extra });
    const finishedAt = this.clock().toISOString();
    session.status = status;
    session.finishedAt = finishedAt;
    this.#store(session);
    const output = freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'multi-agent-coordination', executionId, correlationId: session.correlationId, teamId: session.teamId, task: session.task, status, startedAt: session.startedAt, finishedAt, ...extra, ...(error ? { error } : {}), session: this.getSession(executionId) });
    this.#emit({ type: status === 'succeeded' ? 'multi-agent.coordination.completed' : status === 'cancelled' ? 'multi-agent.coordination.cancelled' : 'multi-agent.coordination.failed', executionId, correlationId: session.correlationId, teamId: session.teamId, status, data: output, error });
    return output;
  }

  #store(session) { this.sessions.set(session.executionId, structuredClone(session)); }
  #emit(event) { this.events?.emit({ schemaVersion: SCHEMA_VERSION, timestamp: this.clock().toISOString(), ...event }); }
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) throw coordinationFailure('PARTICIPANTS_INVALID', 'members must be an array');
  const normalized = members.map((member, index) => {
    const agent = typeof member === 'string' ? member : member?.agent;
    const id = typeof member === 'string' ? member : member?.id ?? `participant-${index + 1}`;
    if (!agent || typeof agent !== 'string') throw coordinationFailure('PARTICIPANT_INVALID', `Participant ${id} must identify an agent`);
    const dependsOn = typeof member === 'string' ? [] : member.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== 'string')) throw coordinationFailure('PARTICIPANT_DEPENDENCIES_INVALID', `Participant ${id} has invalid dependencies`);
    return { id, agent, task: typeof member === 'string' ? undefined : member.task, input: typeof member === 'string' ? undefined : member.input, dependsOn };
  });
  const ids = new Set(normalized.map((member) => member.id));
  if (ids.size !== normalized.length) throw coordinationFailure('PARTICIPANT_DUPLICATE', 'Participant ids must be unique');
  const position = new Map(normalized.map((member, index) => [member.id, index]));
  normalized.forEach((member) => member.dependsOn.forEach((dependency) => { if (!ids.has(dependency) || dependency === member.id || position.get(dependency) >= position.get(member.id)) throw coordinationFailure('PARTICIPANT_DEPENDENCY_INVALID', `Participant ${member.id} has invalid dependency: ${dependency}`); }));
  return normalized;
}

class SharedContextAdapter {
  constructor(initial, clock) { this.values = structuredClone(initial && typeof initial === 'object' ? initial : {}); this.version = 0; this.clock = clock; }
  snapshot() { return { version: this.version, values: structuredClone(this.values) }; }
  commit(patch, { expectedVersion = this.version } = {}) { if (expectedVersion !== this.version) throw Object.assign(new Error('Shared context version conflict'), { code: 'CONTEXT_VERSION_CONFLICT', retryable: true }); this.values = { ...this.values, ...structuredClone(patch) }; this.version += 1; return this.snapshot(); }
}
function coordinationFailure(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }
function normalizeError(error) { return { code: error?.code ?? 'MULTI_AGENT_COORDINATION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freezeDeep(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freezeDeep(child); return Object.freeze(value); }
function defaultExecutionId(teamId) { return `team-coordination-${teamId}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as MULTI_AGENT_COORDINATION_SCHEMA_VERSION };
