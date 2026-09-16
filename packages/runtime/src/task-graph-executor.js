export class TaskGraphExecutor {
  constructor({ executeTask, events = null, clock = () => new Date() } = {}) {
    if (typeof executeTask !== 'function') throw new TypeError('TaskGraphExecutor requires executeTask');
    this.executeTask = executeTask;
    this.events = events;
    this.clock = clock;
  }

  async execute(plan, input = {}, context = {}, options = {}) {
    validatePlan(plan);
    const strategy = options.strategy === 'parallel' ? 'parallel' : 'sequential';
    const maxConcurrency = Math.max(1, Math.min(Number(options.maxConcurrency) || 1, plan.tasks.length));
    const failFast = options.failFast !== false;
    const executionId = context.executionId ?? `taskgraph-${this.clock().getTime()}`;
    const startedAt = this.clock().toISOString();
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const results = new Map();
    const pending = new Set(plan.order);
    const skipped = new Set();

    this.events?.emit({ type: 'task-graph.started', executionId, status: 'started', data: { taskCount: plan.taskCount, strategy, maxConcurrency } });

    const runTask = async (task) => {
      const taskInput = task.input === null || task.input === undefined ? input : task.input;
      const taskContext = { ...context, executionId, taskId: task.id, taskResults: Object.fromEntries(results) };
      this.events?.emit({ type: 'task.started', executionId, taskId: task.id, status: 'started', data: { dependsOn: task.dependsOn } });
      try {
        const result = await this.executeTask(task, taskInput, taskContext);
        const normalized = normalizeResult(result);
        results.set(task.id, normalized);
        this.events?.emit({ type: normalized.status === 'succeeded' ? 'task.completed' : 'task.failed', executionId, taskId: task.id, status: normalized.status, data: normalized, error: normalized.error });
        return normalized;
      } catch (error) {
        const normalized = { status: 'failed', error: normalizeError(error) };
        results.set(task.id, normalized);
        this.events?.emit({ type: 'task.failed', executionId, taskId: task.id, status: 'failed', error: normalized.error, data: normalized });
        return normalized;
      }
    };

    while (pending.size) {
      const ready = plan.order
        .map((id) => byId.get(id))
        .filter((task) => pending.has(task.id) && task.dependsOn.every((dependency) => results.has(dependency) || skipped.has(dependency)));
      if (!ready.length) throw Object.assign(new Error('Task graph could not make progress'), { code: 'TASK_GRAPH_STALLED', retryable: false });

      const executable = ready.filter((task) => task.dependsOn.every((dependency) => results.get(dependency)?.status === 'succeeded'));
      const blocked = ready.filter((task) => !executable.includes(task));
      for (const task of blocked) {
        pending.delete(task.id);
        skipped.add(task.id);
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
      const result = { status: 'skipped', error: { code: 'TASK_FAIL_FAST', message: `Task was not started: ${id}`, retryable: false } };
      results.set(id, result);
    }

    const orderedResults = plan.order.map((id) => ({ taskId: id, ...results.get(id) }));
    const failed = orderedResults.some((result) => result.status === 'failed');
    const skippedCount = orderedResults.filter((result) => result.status === 'skipped').length;
    const output = {
      schemaVersion: '0.1.0',
      type: 'task-graph-execution',
      executionId,
      goal: plan.goal,
      startedAt,
      finishedAt: this.clock().toISOString(),
      status: failed || skippedCount ? 'failed' : 'succeeded',
      strategy,
      results: orderedResults
    };
    this.events?.emit({ type: output.status === 'succeeded' ? 'task-graph.completed' : 'task-graph.failed', executionId, status: output.status, data: output });
    return output;
  }
}

function validatePlan(plan) {
  if (!plan || plan.type !== 'task-plan' || plan.schemaVersion !== '0.1.0' || !Array.isArray(plan.tasks) || !Array.isArray(plan.order)) {
    throw Object.assign(new Error('Invalid task plan'), { code: 'TASK_PLAN_INVALID', retryable: false });
  }
  if (plan.taskCount !== plan.tasks.length || plan.order.length !== plan.tasks.length) {
    throw Object.assign(new Error('Task plan count/order mismatch'), { code: 'TASK_PLAN_INVALID', retryable: false });
  }
}

function normalizeResult(result) {
  if (result && typeof result === 'object' && typeof result.status === 'string') return result;
  return { status: 'succeeded', output: result ?? null };
}

function normalizeError(error) {
  return { code: error?.code ?? 'TASK_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}
