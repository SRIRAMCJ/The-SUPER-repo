import { createExecutionId } from './events.js';
import { ExecutionCancellationRegistry } from './cancellation.js';

const VALID_STATUSES = new Set(['succeeded', 'failed', 'skipped']);

export class TaskGraphExecutor {
  constructor({ executeTask, events = null, clock = () => new Date(), stateStore = null, cancellation = new ExecutionCancellationRegistry() } = {}) {
    if (typeof executeTask !== 'function') throw new TypeError('TaskGraphExecutor requires executeTask');
    if (!cancellation || typeof cancellation.register !== 'function' || typeof cancellation.cancel !== 'function') throw new TypeError('TaskGraphExecutor cancellation must expose register and cancel');
    this.executeTask = executeTask;
    this.events = events;
    this.clock = clock;
    this.stateStore = stateStore;
    this.cancellation = cancellation;
  }

  cancel(executionId, reason = 'Task graph execution cancelled') { return this.cancellation.cancel(executionId, reason); }

  async execute(plan, input = {}, context = {}, options = {}) {
    validatePlan(plan);
    const config = normalizeOptions(options, plan.taskCount);
    const executionId = context.taskGraphExecutionId ?? context.executionId ?? createExecutionId();
    return this.#run(plan, executionId, this.clock().toISOString(), input, context, config, new Map(), 1, false);
  }

  async resume(plan, executionId, context = {}, options = {}) {
    validatePlan(plan);
    if (!this.stateStore) throw taskGraphFailure('EXECUTION_STATE_UNAVAILABLE', 'Execution state store is required for task graph resume');
    const state = await this.stateStore.get(executionId);
    if (!state) return failure(executionId, plan, 'EXECUTION_STATE_NOT_FOUND', `Execution state not found: ${executionId}`);
    if (state.type !== 'execution-state' || state.kind !== 'task-graph') return failure(executionId, plan, 'EXECUTION_STATE_TYPE_INVALID', `Execution state is not a task graph: ${executionId}`);
    if (JSON.stringify(state.plan) !== JSON.stringify(plan)) return failure(executionId, plan, 'EXECUTION_STATE_PLAN_MISMATCH', `Execution state plan does not match: ${executionId}`);
    if (state.status === 'succeeded') return state.result ?? failure(executionId, plan, 'EXECUTION_STATE_RESULT_MISSING', `Completed state has no result: ${executionId}`);
    if (state.status === 'running' && !options.allowRunning) return failure(executionId, plan, 'EXECUTION_ALREADY_RUNNING', `Execution is already running: ${executionId}`);
    if (state.status !== 'failed' && state.status !== 'running') return failure(executionId, plan, 'EXECUTION_NOT_RESUMABLE', `Execution is not resumable: ${state.status}`);
    const priorResults = new Map((state.results ?? []).filter((entry) => entry?.status === 'succeeded').map((entry) => [entry.taskId, entry]));
    const config = normalizeOptions({ strategy: state.strategy, maxConcurrency: state.maxConcurrency, failFast: state.failFast, ...options }, plan.taskCount);
    let claimed;
    try {
      claimed = await this.stateStore.update(executionId, { status: 'running', attempt: (state.attempt ?? 1) + 1, error: null, result: null }, state.version);
    } catch (error) {
      return failure(executionId, plan, error?.code ?? 'EXECUTION_STATE_CONFLICT', error instanceof Error ? error.message : String(error), Boolean(error?.retryable));
    }
    return this.#run(plan, executionId, state.startedAt ?? this.clock().toISOString(), state.input ?? {}, context, config, priorResults, claimed.attempt, true);
  }

  async #run(plan, executionId, startedAt, input, context, config, results, attempt, resumed) {
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const pending = new Set(plan.order.filter((id) => !results.has(id)));
    if (this.stateStore && !resumed) await this.stateStore.create({ schemaVersion: '0.1.0', type: 'execution-state', executionId, kind: 'task-graph', status: 'running', plan, input, results: [], strategy: config.strategy, maxConcurrency: config.maxConcurrency, failFast: config.failFast, attempt, startedAt });
    const controller = new AbortController();
    let cancelPromise;
    try {
      cancelPromise = this.cancellation.register(executionId, controller);
    } catch (error) {
      return failure(executionId, plan, error?.code ?? 'EXECUTION_ALREADY_REGISTERED', error instanceof Error ? error.message : String(error));
    }
    this.events?.emit({ type: resumed ? 'task-graph.resumed' : 'task-graph.started', executionId, status: 'started', data: { taskCount: plan.taskCount, strategy: config.strategy, maxConcurrency: config.maxConcurrency, failFast: config.failFast, attempt } });
    const persist = async (patch) => { if (this.stateStore) await this.stateStore.update(executionId, patch); };

    const runTask = async (task) => {
      const taskInput = task.input === null || task.input === undefined ? input : task.input;
      const taskContext = { ...context, executionId, taskId: task.id, signal: controller.signal, taskResults: Object.fromEntries(results) };
      this.events?.emit({ type: 'task.started', executionId, taskId: task.id, status: 'started', data: { dependsOn: task.dependsOn, attempt } });
      try {
        const taskPromise = (config.executeTask ?? this.executeTask)(task, taskInput, taskContext);
        const normalized = normalizeResult(await Promise.race([taskPromise, cancelPromise]));
        results.set(task.id, normalized);
        const cancelled = normalized.error?.code === 'EXECUTION_CANCELLED';
        await persist({ status: cancelled ? 'cancelled' : normalized.status === 'succeeded' ? 'running' : 'failed', currentTaskId: task.id, results: orderedResults(plan, results), error: normalized.error ?? null, attempt });
        this.events?.emit({ type: normalized.status === 'succeeded' ? 'task.completed' : normalized.status === 'skipped' ? 'task.skipped' : 'task.failed', executionId, taskId: task.id, status: normalized.status, data: normalized, error: normalized.error });
        return normalized;
      } catch (error) {
        const normalized = { status: 'failed', error: normalizeError(error) };
        results.set(task.id, normalized);
        await persist({ status: normalized.error.code === 'EXECUTION_CANCELLED' ? 'cancelled' : 'failed', currentTaskId: task.id, results: orderedResults(plan, results), error: normalized.error, attempt });
        this.events?.emit({ type: 'task.failed', executionId, taskId: task.id, status: normalized.status, error: normalized.error, data: normalized });
        return normalized;
      }
    };

    try {
      while (pending.size) {
        if (controller.signal.aborted) throw controller.signal.reason ?? taskGraphFailure('EXECUTION_CANCELLED', 'Task graph execution cancelled');
        const ready = plan.order.map((id) => byId.get(id)).filter((task) => pending.has(task.id) && task.dependsOn.every((dependency) => results.has(dependency)));
        if (!ready.length) throw taskGraphFailure('TASK_GRAPH_STALLED', 'Task graph could not make progress');
        const executable = ready.filter((task) => task.dependsOn.every((dependency) => results.get(dependency)?.status === 'succeeded'));
        for (const task of ready.filter((task) => !executable.includes(task))) {
          pending.delete(task.id);
          results.set(task.id, { status: 'skipped', error: { code: 'TASK_DEPENDENCY_FAILED', message: `Task dependency failed: ${task.id}`, retryable: false } });
        }
        if (!executable.length) break;
        const batch = config.strategy === 'sequential' ? executable.slice(0, 1) : executable.slice(0, config.maxConcurrency);
        batch.forEach((task) => pending.delete(task.id));
        const batchResults = await Promise.all(batch.map(runTask));
        if (batchResults.some((result) => result.error?.code === 'EXECUTION_CANCELLED')) throw Object.assign(new Error('Task graph execution cancelled'), { code: 'EXECUTION_CANCELLED', retryable: false });
        if (config.failFast && batchResults.some((result) => result.status !== 'succeeded')) break;
      }
      for (const id of pending) results.set(id, { status: 'skipped', error: { code: controller.signal.aborted ? 'TASK_CANCELLED' : config.failFast ? 'TASK_FAIL_FAST' : 'TASK_NOT_SCHEDULED', message: `Task was not started: ${id}`, retryable: false } });
      const output = finish(plan, executionId, startedAt, config, results, resumed, attempt, this.clock, controller.signal.aborted ? 'cancelled' : null);
      await persist({ status: output.status, results: output.results, output: output.output ?? null, result: output, error: output.error ?? null, finishedAt: output.finishedAt, attempt, currentTaskId: null });
      this.events?.emit({ type: output.status === 'succeeded' ? 'task-graph.completed' : output.status === 'cancelled' ? 'task-graph.cancelled' : 'task-graph.failed', executionId, status: output.status, data: output, error: output.error });
      return output;
    } catch (error) {
      const normalized = normalizeError(error);
      const cancelled = normalized.code === 'EXECUTION_CANCELLED' || controller.signal.aborted;
      const output = { schemaVersion: '0.1.0', type: 'task-graph-execution', executionId, goal: plan.goal, startedAt, finishedAt: this.clock().toISOString(), status: cancelled ? 'cancelled' : 'failed', strategy: config.strategy, maxConcurrency: config.maxConcurrency, failFast: config.failFast, rootTaskId: plan.order.at(-1), results: orderedResults(plan, results), error: cancelled ? { code: 'EXECUTION_CANCELLED', message: normalized.message, retryable: false } : normalized, resumed, attempt };
      await persist({ status: output.status, results: output.results, result: output, error: output.error, finishedAt: output.finishedAt, attempt });
      this.events?.emit({ type: cancelled ? 'task-graph.cancelled' : 'task-graph.failed', executionId, status: output.status, error: output.error, data: output });
      return output;
    } finally {
      this.cancellation.unregister(executionId);
    }
  }
}

function finish(plan, executionId, startedAt, config, results, resumed, attempt, clock, forcedStatus = null) {
  const ordered = orderedResults(plan, results);
  const failed = ordered.some((result) => result.status === 'failed');
  const skipped = ordered.some((result) => result.status === 'skipped');
  const rootResult = ordered.at(-1);
  const output = { schemaVersion: '0.1.0', type: 'task-graph-execution', executionId, goal: plan.goal, startedAt, finishedAt: clock().toISOString(), status: forcedStatus ?? (failed || skipped ? 'failed' : 'succeeded'), strategy: config.strategy, maxConcurrency: config.maxConcurrency, failFast: config.failFast, rootTaskId: plan.order.at(-1), output: rootResult?.output ?? null, results: ordered, resumed, attempt };
  if (forcedStatus === 'cancelled') output.error = { code: 'EXECUTION_CANCELLED', message: 'Task graph execution cancelled', retryable: false };
  else if (failed && rootResult?.error) output.error = structuredClone(rootResult.error);
  return output;
}

function orderedResults(plan, results) { return plan.order.filter((id) => results.has(id)).map((id) => ({ taskId: id, ...results.get(id) })); }

function validatePlan(plan) {
  if (!plan || plan.type !== 'task-plan' || plan.schemaVersion !== '0.1.0' || !Array.isArray(plan.tasks) || !Array.isArray(plan.order)) throw taskGraphFailure('TASK_PLAN_INVALID', 'Invalid task plan');
  if (!Number.isInteger(plan.taskCount) || plan.taskCount <= 0 || plan.taskCount !== plan.tasks.length || plan.order.length !== plan.tasks.length) throw taskGraphFailure('TASK_PLAN_INVALID', 'Task plan count/order mismatch');
  const ids = new Set(plan.tasks.map((task) => task?.id));
  if (ids.size !== plan.tasks.length || [...ids].some((id) => typeof id !== 'string' || !id)) throw taskGraphFailure('TASK_PLAN_INVALID', 'Task plan contains invalid or duplicate task ids');
  const orderedIds = new Set(plan.order);
  if (orderedIds.size !== plan.order.length || ids.size !== orderedIds.size || [...ids].some((id) => !orderedIds.has(id))) throw taskGraphFailure('TASK_PLAN_INVALID', 'Task plan order does not match task ids');
  const position = new Map(plan.order.map((id, index) => [id, index]));
  for (const task of plan.tasks) {
    if (!Array.isArray(task.dependsOn)) throw taskGraphFailure('TASK_PLAN_INVALID', `Task ${task.id} has invalid dependencies`);
    for (const dependency of task.dependsOn) if (!ids.has(dependency) || dependency === task.id || position.get(dependency) >= position.get(task.id)) throw taskGraphFailure('TASK_PLAN_INVALID', `Task ${task.id} has an invalid dependency: ${dependency}`);
  }
}

function normalizeOptions(options, taskCount) {
  const strategy = options.strategy ?? 'sequential';
  if (strategy !== 'sequential' && strategy !== 'parallel') throw taskGraphFailure('TASK_STRATEGY_INVALID', `Unsupported task graph strategy: ${strategy}`);
  const value = options.maxConcurrency ?? 1;
  if (!Number.isInteger(value) || value < 1) throw taskGraphFailure('TASK_CONCURRENCY_INVALID', 'maxConcurrency must be a positive integer');
  if (options.executeTask !== undefined && typeof options.executeTask !== 'function') throw taskGraphFailure('TASK_EXECUTOR_INVALID', 'executeTask must be a function');
  return { strategy, maxConcurrency: Math.min(value, taskCount), failFast: options.failFast !== false, executeTask: options.executeTask ?? null };
}

function normalizeResult(result) {
  if (result && typeof result === 'object' && typeof result.status === 'string') {
    if (!VALID_STATUSES.has(result.status)) throw taskGraphFailure('TASK_RESULT_INVALID', `Unsupported task result status: ${result.status}`);
    return result;
  }
  return { status: 'succeeded', output: result ?? null };
}

function normalizeError(error) { return { code: error?.code ?? 'TASK_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function failure(executionId, plan, code, message, retryable = false) { return { executionId, rootTaskId: plan.order.at(-1), status: 'failed', error: { code, message, retryable } }; }
function taskGraphFailure(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }
