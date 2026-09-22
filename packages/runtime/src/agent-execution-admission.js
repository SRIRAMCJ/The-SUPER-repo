const SCHEMA_VERSION = '0.1.0';
const DECISIONS = new Set(['ready', 'blocked', 'invalid']);

export class AgentExecutionAdmission {
  constructor({ registry, governance = null, taskGraphExecutor, executionEngine, clock = () => new Date(), idFactory = defaultExecutionId, maxPlanAgeMs = null, events = null } = {}) {
    if (!registry || typeof registry.resolve !== 'function' || typeof registry.require !== 'function') throw new TypeError('AgentExecutionAdmission requires a capability registry');
    if (!taskGraphExecutor || typeof taskGraphExecutor.execute !== 'function') throw new TypeError('AgentExecutionAdmission requires TaskGraphExecutor');
    if (!executionEngine || typeof executionEngine.execute !== 'function') throw new TypeError('AgentExecutionAdmission requires ExecutionEngine');
    if (governance && typeof governance.authorize !== 'function') throw new TypeError('governance must expose authorize()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (maxPlanAgeMs !== null && (!Number.isFinite(maxPlanAgeMs) || maxPlanAgeMs < 0)) throw new TypeError('maxPlanAgeMs must be null or a non-negative number');
    this.registry = registry; this.governance = governance; this.taskGraphExecutor = taskGraphExecutor; this.executionEngine = executionEngine; this.clock = clock; this.idFactory = idFactory; this.maxPlanAgeMs = maxPlanAgeMs; this.events = events;
  }
  admit(plan, context = {}) {
    const timestamp = this.clock().toISOString(); const reasons = validatePlan(plan, this.clock, this.maxPlanAgeMs);
    if (reasons.length) return decision('invalid', plan?.planId ?? null, timestamp, reasons);
    if (plan.executionDecision?.status !== 'ready') return decision(plan.executionDecision?.status === 'blocked' ? 'blocked' : 'invalid', plan.planId, timestamp, plan.executionDecision?.reasons?.length ? clone(plan.executionDecision.reasons) : [{ code: 'PLAN_NOT_READY', message: 'Plan is not ready for execution' }]);
    const capabilityReasons = [];
    for (const capabilityId of plan.requiredCapabilities ?? collectCapabilities(plan.graph.tasks)) {
      const entry = this.registry.resolve(capabilityId);
      if (!entry) capabilityReasons.push({ code: 'CAPABILITY_MISSING', capabilityId, message: `Required capability is not registered: ${capabilityId}` });
      else if (['disabled', 'deprecated'].includes(entry.manifest?.status)) capabilityReasons.push({ code: 'CAPABILITY_UNAVAILABLE', capabilityId, message: `Required capability is unavailable: ${capabilityId} (${entry.manifest.status})` });
    }
    const governanceReasons = this.governance ? authorizeTasks(plan.graph.tasks, this.governance, context) : [];
    const blocked = [...capabilityReasons, ...governanceReasons.filter((item) => !item.allowed).map((item) => ({ code: 'GOVERNANCE_DENIED', taskId: item.taskId, capabilityId: item.operationId, message: item.reason }))];
    const result = decision(blocked.length ? 'blocked' : 'ready', plan.planId, timestamp, blocked, governanceReasons.length ? governanceReasons : null);
    this.events?.emit({ type: result.status === 'ready' ? 'agent.execution.admitted' : 'agent.execution.blocked', status: result.status, planId: plan.planId, data: result }); return result;
  }
  async execute(plan, input = {}, context = {}, options = {}) {
    const admission = this.admit(plan, context); if (admission.status !== 'ready') return admission;
    const executionId = context.executionId ?? this.idFactory(plan.planId);
    const envelope = freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'agent-execution-envelope', executionId, planId: plan.planId, correlationId: context.correlationId ?? executionId, admittedAt: admission.timestamp, integrity: { fingerprint: fingerprint(plan) }, goal: plan.goal, input: clone(input), context: clone(context) });
    const graphPlan = toTaskPlan(plan); this.events?.emit({ type: 'agent.execution.started', executionId, planId: plan.planId, status: 'started', data: { envelope } });
    const executeTask = async (task, taskInput, taskContext) => {
      const capabilityIds = Array.isArray(task.capabilities) && task.capabilities.length ? task.capabilities : task.agent ? [task.agent] : [];
      if (!capabilityIds.length) return { status: 'failed', error: { code: 'CAPABILITY_MISSING', message: `Task has no executable capability: ${task.id}`, retryable: false } };
      let currentInput = taskInput; let lastResult = null;
      for (const capabilityId of capabilityIds) {
        if (taskContext.signal?.aborted) return { status: 'failed', error: taskContext.signal.reason ?? { code: 'EXECUTION_CANCELLED', message: 'Agent execution cancelled', retryable: false } };
        lastResult = await this.executionEngine.execute(capabilityId, currentInput, { ...taskContext, executionId: `${executionId}:${task.id}:${capabilityId}`, parentExecutionId: executionId, correlationId: `${envelope.correlationId}:${task.id}:${capabilityId}` });
        if (lastResult.status !== 'succeeded') return { status: 'failed', error: lastResult.error ?? { code: 'CAPABILITY_EXECUTION_FAILED', message: `Capability execution failed: ${capabilityId}`, retryable: false }, capabilityId, execution: clone(lastResult) };
        currentInput = lastResult.output;
      }
      return { status: 'succeeded', output: currentInput, execution: clone(lastResult) };
    };
    try {
      const result = await this.taskGraphExecutor.execute(graphPlan, input, { ...context, executionId, correlationId: envelope.correlationId, agentExecutionEnvelope: envelope }, { ...options, executeTask });
      const output = freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'agent-execution', executionId, planId: plan.planId, correlationId: envelope.correlationId, status: result.status, envelope, result: clone(result) });
      this.events?.emit({ type: output.status === 'succeeded' ? 'agent.execution.completed' : 'agent.execution.failed', executionId, planId: plan.planId, status: output.status, data: output, error: result.error }); return output;
    } catch (error) {
      const normalized = normalizeError(error); const output = freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'agent-execution', executionId, planId: plan.planId, correlationId: envelope.correlationId, status: 'failed', envelope, error: normalized });
      this.events?.emit({ type: 'agent.execution.failed', executionId, planId: plan.planId, status: 'failed', error: normalized, data: output }); return output;
    }
  }
}
function validatePlan(plan, clock, maxPlanAgeMs) {
  const reasons = []; if (!plan || plan.type !== 'agent-plan' || plan.schemaVersion !== SCHEMA_VERSION) return [{ code: 'PLAN_SCHEMA_INVALID', message: 'Unsupported or invalid agent plan schema' }];
  if (typeof plan.planId !== 'string' || !plan.planId) reasons.push({ code: 'PLAN_ID_MISSING', message: 'Agent plan requires a planId' });
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) reasons.push({ code: 'PLAN_GOAL_INVALID', message: 'Agent plan requires a non-empty goal' });
  if (!plan.graph || !Array.isArray(plan.graph.tasks) || !Array.isArray(plan.graph.order) || plan.graph.taskCount !== plan.graph.tasks.length || plan.graph.order.length !== plan.graph.tasks.length) reasons.push({ code: 'PLAN_GRAPH_INVALID', message: 'Agent plan graph is inconsistent' });
  if (!Array.isArray(plan.requiredCapabilities)) reasons.push({ code: 'PLAN_CAPABILITIES_INVALID', message: 'Agent plan requiredCapabilities must be an array' });
  if (maxPlanAgeMs !== null && typeof plan.createdAt === 'string') { const created = Date.parse(plan.createdAt); const now = clock().getTime(); if (!Number.isFinite(created) || created > now || now - created > maxPlanAgeMs) reasons.push({ code: 'PLAN_STALE', message: 'Agent plan is outside the permitted execution age' }); }
  if (plan.integrity?.fingerprint && plan.integrity.fingerprint !== fingerprint(plan)) reasons.push({ code: 'PLAN_INTEGRITY_MISMATCH', message: 'Agent plan integrity fingerprint does not match its contents' }); return reasons;
}
function toTaskPlan(plan) { return freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'task-plan', createdAt: plan.createdAt, goal: plan.goal, taskCount: plan.graph.taskCount, tasks: plan.graph.tasks, order: plan.graph.order }); }
function collectCapabilities(tasks) { return [...new Set(tasks.flatMap((task) => Array.isArray(task.capabilities) ? task.capabilities : task.agent ? [task.agent] : []))].sort(); }
function authorizeTasks(tasks, governance, context) { return tasks.flatMap((task) => (Array.isArray(task.capabilities) && task.capabilities.length ? task.capabilities : task.agent ? [task.agent] : []).map((operationId) => ({ taskId: task.id, ...governance.authorize({ id: operationId, classification: 'control' }, context) }))); }
function decision(status, planId, timestamp, reasons, governance = null) { return freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'agent-execution-admission', status, planId, timestamp, reasons: clone(reasons), governance: governance ? clone(governance) : null }); }
function fingerprint(plan) { return stableHash(JSON.stringify({ schemaVersion: plan.schemaVersion, planId: plan.planId, goal: plan.goal, graph: plan.graph, requiredCapabilities: plan.requiredCapabilities })); }
function stableHash(input) { let hash = 2166136261; for (let index = 0; index < input.length; index += 1) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 16777619); } return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`; }
function defaultExecutionId(planId) { return `agent-exec-${planId}-${Date.now().toString(36)}`; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freezeDeep(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freezeDeep(child); return Object.freeze(value); }
function normalizeError(error) { return { code: error?.code ?? 'AGENT_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }

export { SCHEMA_VERSION as AGENT_EXECUTION_ADMISSION_SCHEMA_VERSION, DECISIONS as AGENT_EXECUTION_ADMISSION_DECISIONS, fingerprint as fingerprintAgentPlan };
