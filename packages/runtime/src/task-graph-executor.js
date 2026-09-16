import { createExecutionId } from './events.js';

const VALID_STATUSES = new Set(['succeeded', 'failed', 'skipped']);

export class TaskGraphExecutor {
  constructor({ executeTask, events = null, clock = () => new Date() } = {}) {
    if (typeof executeTask !== 'function') throw new TypeError('TaskGraphExecutor requires executeTask');
    this.executeTask = executeTask;
    this.events = events;
    this.clock = clock;
  }

  async execute(plan, input = {}, context = {}, options = {}) {
    validatePlan(plan);
    const strategy = options.strategy ?? 'sequential';
    if (strategy !== 'sequential' && strategy !== 'parallel') {
      throw taskGraphFailure('TASK_STRATEGY_INVALID', `Unsupported task graph strategy: ${strategy}`);
    }
    const maxConcurrency = normalizeConcurrency(options.maxConcurrency, plan.tasks.length);
    const failFast = options.failFast !== false;
    const executionId = context.executionId ?? createExecutionId();
    const startedAt = this.clock().toISOString();
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const results = new Map();
    const pending = new Set(plan.order);

    this.events?.emit({ type: 'task-graph.started', executionId, status: 'started', data: { taskCount: plan.taskCount, strategy, maxConcurrency, failFast } });

    const runTask = async (task) => {
      const taskInput = task.input === null || task.input === undefined ? input : task.input;
      const taskContext = { ...context, executionId, taskId: task.id, taskResults: Object.fromEntries(results) };
      this.events?.emit({ type: 'task.started', executionId, taskId: task.id, status: 'started', data: { dependsOn: task.dependsOn } });
      try {
        const normalized = normalizeResult(await this.executeTask(task, taskInput, taskContext));
        results.set(task.id, normalized);
        this.events?.emit({
          type: normalized.status === 'succeeded' ? 'task.completed' : normalized.status === 'skipped' ? 'task.skipped' : 'task.failed',
          executionId,
          taskId: task.id,
          status: normalized.status,
          data: normalized,
          error: normalized.error
        });
        return normalized;
      } catch (error) {
        const normalized = { status: 'failed', error: normalizeError(error) };
        results.set(task.id, normalized);
        this.events?.emit({ type: 'task.failed', executionId, taskId: task.id, status: 'failed', error: normalized.error, data: normalized });
        return normalized;
      }
    };

    try {
      while (pending.size) {
        const ready = plan.order
          .map((id) => byId.get(id))
          .filter((task) => pending.has(task.id) && task.dependsOn.every((dependency) => results.has(dependency)));
        if (!ready.length) throw taskGraphFailure('TASK_GRAPH_STALLED', 'Task graph could not make progress');

        const executable = ready.filter((task) => task.dependsOn.every((dependency) => results.get(dependency)?.status === 'succeeded'));
        const blocked = ready.filter((task) => !executable.includes(task));
        for (const task of blocked) {
          pending.delete(task.id);
          const result = { status: 'skipped', error: { code: 'TASK_DEPENDENCY_FAILED', message: `Task dependency failed: ${task.id}`, retryable: false } };
          results.set(task.id, result);
          this.events?.emit({ type: 'task.skipped', executionId, taskId: task.id, status: 'skipped', data: result, error: result.error });
        }

        if (!executable.length) {
          if (failFast) break;
          continue;
        }

        const batch = strategy === 'sequential' ? executable.slice(0, 1) : executable.slice(0, maxConcurrency);
        batch.forEach((task) => pending.delete(task.id));
        const batchResults = await Promise.all(batch.map(runTask));
        if (failFast && batchResults.some((result) => result.status !== 'succeeded')) break;
      }

      for (const id of pending) {
        results.set(id, {
          status: 'skipped',
          error: {
            code: failFast ? 'TASK_FAIL_FAST' : 'TASK_NOT_SCHEDULED',
            message: `Task was not started: ${id}`,
            retryable: false
          }
        });
      }

      return this.finish(plan, executionId, startedAt, strategy, maxConcurrency, failFast, results);
    } catch (error) {
      const normalized = normalizeError(error);
      const output = {
        schemaVersion: '0.1.0',
        type: 'task-graph-execution',
        executionId,
        goal: plan.goal,
        startedAt,
        finishedAt: this.clock().toISOString(),
        status: 'failed',
        strategy,
        maxConcurrency,
        failFast,
        rootTaskId: plan.order.at(-1),
        results: plan.order.filter((id) => results.has(id)).map((id) => ({ taskId: id, ...results.get(id) })),
        error: normalized
      };
      this.events?.emit({ type: 'task-graph.failed', executionId, status: 'failed', error: normalized, data: output });
      return output;
    }
  }

  finish(plan, executionId, startedAt, strategy, maxConcurrency, failFast, results) {
    const orderedResults = plan.order.map((id) => ({ taskId: id, ...results.get(id) }));
    const failed = orderedResults.some((result) => result.status === 'failed');
    const skippedCount = orderedResults.filter((result) => result.status === 'skipped').length;
    const rootResult = orderedResults.at(-1);
    const output = {
      schemaVersion: '0.1.0',
      type: 'task-graph-execution',
      executionId,
      goal: plan.goal,
      startedAt,
      finishedAt: this.clock().toISOString(),
      status: failed || skippedCount ? 'failed' : 'succeeded',
      strategy,
      maxConcurrency,
      failFast,
      rootTaskId: plan.order.at(-1),
      output: rootResult?.output ?? null,
      results: orderedResults
    };
    this.events?.emit({ type: output.status === 'succeeded' ? 'task-graph.completed' : 'task-graph.failed', executionId, status: output.status, data: output, error: failed ? rootResult?.error : undefined });
    return output;
  }
}

function validatePlan(plan) {
  if (!plan || plan.type !== 'task-plan' || plan.schemaVersion !== '0.1.0' || !Array.isArray(plan.tasks) || !Array.isArray(plan.order)) {
    throw taskGraphFailure('TASK_PLAN_INVALID', 'Invalid task plan');
  }
  if (!Number.isInteger(plan.taskCount) || plan.taskCount <= 0 || plan.taskCount !== plan.tasks.length || plan.order.length !== plan.tasks.length) {
    throw taskGraphFailure('TASK_PLAN_INVALID', 'Task plan count/order mismatch');
  }

  const ids = new Set();
  for (const task of plan.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id.trim() || ids.has(task.id)) {
      throw taskGraphFailure('TASK_PLAN_INVALID', 'Task plan contains an invalid or duplicate task id');
    }
    ids.add(task.id);
    if (!Array.isArray(task.dependsOn)) throw taskGraphFailure('TASK_PLAN_INVALID', `Task ${task.id} has invalid dependencies`);
    for (const dependency of task.dependsOn) {
      if (dependency === task.id || typeof dependency !== 'string' || !ids.has(dependency) && !plan.tasks.some((candidate) => candidate.id === dependency)) {
        throw taskGraphFailure('TASK_PLAN_INVALID', `Task ${task.id} has an invalid dependency: ${dependency}`);
      }
    }
  }

  const orderedIds = new Set(plan.order);
  if (orderedIds.size !== plan.order.length || ids.size !== orderedIds.size || [...ids].some((id) => !orderedIds.has(id))) {
    throw taskGraphFailure('TASK_PLAN_INVALID', 'Task plan order does not match task ids');
  }

  const position = new Map(plan.order.map((id, index) => [id, index]));
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (position.get(dependency) >= position.get(task.id)) {
        throw taskGraphFailure('TASK_PLAN_INVALID', `Task ${task.id} appears before dependency ${dependency}`);
      }
    }
  }
}

function normalizeConcurrency(value, taskCount) {
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value) || value < 1) throw taskGraphFailure('TASK_CONCURRENCY_INVALID', 'maxConcurrency must be a positive integer');
  return Math.min(value, taskCount);
}

function normalizeResult(result) {
  if (result && typeof result === 'object' && typeof result.status === 'string') {
    if (!VALID_STATUSES.has(result.status)) throw taskGraphFailure('TASK_RESULT_INVALID', `Unsupported task result status: ${result.status}`);
    return result;
  }
  return { status: 'succeeded', output: result ?? null };
}

function normalizeError(error) {
  return { code: error?.code ?? 'TASK_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}

function taskGraphFailure(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}
