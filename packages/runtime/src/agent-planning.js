const SCHEMA_VERSION = '0.1.0';
const DECISIONS = new Set(['ready', 'blocked', 'invalid']);

export class AgentPlanningKernel {
  constructor({ planner, decomposer, registry = null, governance = null, clock = () => new Date(), idFactory = defaultPlanId } = {}) {
    if (!planner || typeof planner.plan !== 'function') throw new TypeError('AgentPlanningKernel requires CapabilityPlanner');
    if (!decomposer || typeof decomposer.decompose !== 'function') throw new TypeError('AgentPlanningKernel requires TaskDecomposer');
    if (registry && typeof registry.resolve !== 'function') throw new TypeError('registry must expose resolve()');
    if (governance && typeof governance.authorize !== 'function') throw new TypeError('governance must expose authorize()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    this.planner = planner;
    this.decomposer = decomposer;
    this.registry = registry;
    this.governance = governance;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  plan(request = {}) {
    const startedAt = this.clock().toISOString();
    try {
      const normalized = normalizeRequest(request);
      const capabilityPlan = this.planner.plan(normalized.goal, {
        kind: normalized.kind,
        limit: normalized.candidateLimit,
        minimumScore: normalized.minimumScore
      });
      const tasks = normalized.tasks ?? deriveTasks(capabilityPlan, normalized);
      if (!tasks.length) return invalid(normalized.goal, 'TASKS_MISSING', 'No executable tasks could be derived from the goal', startedAt);

      const decomposition = this.decomposer.decompose({ goal: normalized.goal, tasks });
      const requiredCapabilities = collectCapabilities(decomposition.tasks);
      const unresolved = resolveCapabilities(requiredCapabilities, this.registry);
      const governance = this.governance ? authorizeTasks(decomposition.tasks, this.governance, normalized.context) : [];
      const blocked = [...unresolved, ...governance.filter((item) => !item.allowed).map((item) => ({
        code: 'GOVERNANCE_DENIED', taskId: item.taskId, capabilityId: item.operationId, message: item.reason
      }))];
      const decision = blocked.length ? 'blocked' : 'ready';

      return freezeDeep({
        schemaVersion: SCHEMA_VERSION,
        type: 'agent-plan',
        planId: this.idFactory(normalized.goal, decomposition.order),
        createdAt: startedAt,
        goal: normalized.goal,
        context: normalized.context,
        capabilityPlan,
        graph: {
          taskCount: decomposition.taskCount,
          order: decomposition.order,
          tasks: decomposition.tasks
        },
        requiredCapabilities,
        governance: governance.length ? governance : null,
        unresolvedRequirements: blocked,
        executionDecision: { status: decision, reasons: blocked.map(({ code, taskId, capabilityId, message }) => ({ code, taskId, capabilityId, message })) }
      });
    } catch (error) {
      return invalid(request?.goal ?? null, error?.code ?? 'PLANNING_INVALID', error instanceof Error ? error.message : String(error), startedAt);
    }
  }
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('REQUEST_INVALID', 'Planning request must be an object');
  const goal = typeof request.goal === 'string' ? request.goal.trim() : '';
  if (!goal) throw failure('GOAL_INVALID', 'Planning requires a non-empty goal');
  const kind = request.kind ?? 'agent';
  const candidateLimit = request.candidateLimit ?? 5;
  const minimumScore = request.minimumScore ?? 0.15;
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1) throw failure('CANDIDATE_LIMIT_INVALID', 'candidateLimit must be a positive integer');
  if (typeof minimumScore !== 'number' || minimumScore < 0 || minimumScore > 1) throw failure('MINIMUM_SCORE_INVALID', 'minimumScore must be between 0 and 1');
  if (request.tasks !== undefined && (!Array.isArray(request.tasks) || request.tasks.length === 0)) throw failure('TASKS_INVALID', 'tasks must be a non-empty array when supplied');
  return { goal, kind, candidateLimit, minimumScore, tasks: request.tasks, context: request.context && typeof request.context === 'object' ? structuredClone(request.context) : {} };
}

function deriveTasks(capabilityPlan, request) {
  const selection = capabilityPlan.selection;
  if (!selection) return [];
  const task = {
    id: 'task-1',
    title: selection.name ?? selection.capabilityId,
    description: selection.reason,
    agent: selection.capabilityId,
    capabilities: [selection.capabilityId],
    input: request.context.input ?? null,
    priority: 0
  };
  return [task];
}

function collectCapabilities(tasks) {
  return [...new Set(tasks.flatMap((task) => Array.isArray(task.capabilities) ? task.capabilities : task.agent ? [task.agent] : []))].sort();
}

function resolveCapabilities(capabilities, registry) {
  if (!registry) return [];
  return capabilities.filter((id) => !registry.resolve(id)).map((id) => ({ code: 'CAPABILITY_MISSING', capabilityId: id, message: `Required capability is not registered: ${id}` }));
}

function authorizeTasks(tasks, governance, context) {
  return tasks.flatMap((task) => {
    const ids = Array.isArray(task.capabilities) && task.capabilities.length ? task.capabilities : task.agent ? [task.agent] : [];
    return ids.map((operationId) => ({ taskId: task.id, ...governance.authorize({ id: operationId, classification: 'control' }, context) }));
  });
}

function defaultPlanId(goal, order) {
  const input = `${goal}\u0000${order.join(',')}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `plan-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function invalid(goal, code, message, createdAt) {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, type: 'agent-plan', planId: null, createdAt, goal: typeof goal === 'string' ? goal.trim() : null, executionDecision: { status: 'invalid', reasons: [{ code, message }] } });
}

function failure(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export { SCHEMA_VERSION as AGENT_PLANNING_SCHEMA_VERSION, DECISIONS as AGENT_PLANNING_DECISIONS };
