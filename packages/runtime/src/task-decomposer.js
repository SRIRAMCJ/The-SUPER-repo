export class TaskDecomposer {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  decompose(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('Task decomposition request must be an object');
    }
    const goal = typeof request.goal === 'string' ? request.goal.trim() : '';
    if (!goal) throw new TypeError('Task decomposition requires a non-empty goal');
    if (!Array.isArray(request.tasks) || request.tasks.length === 0) {
      throw Object.assign(new Error('Task decomposition requires at least one explicit task'), { code: 'TASKS_MISSING', retryable: false });
    }

    const seen = new Set();
    const tasks = request.tasks.map((task, index) => normalizeTask(task, index));
    for (const task of tasks) {
      if (seen.has(task.id)) throw failure('TASK_ID_DUPLICATE', `Duplicate task id: ${task.id}`);
      seen.add(task.id);
    }

    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      for (const dependency of task.dependsOn) {
        if (!byId.has(dependency)) throw failure('TASK_DEPENDENCY_MISSING', `Task ${task.id} depends on missing task: ${dependency}`);
        if (dependency === task.id) throw failure('TASK_DEPENDENCY_CYCLE', `Task ${task.id} cannot depend on itself`);
      }
    }

    const order = topologicalOrder(tasks);
    if (!order) throw failure('TASK_DEPENDENCY_CYCLE', 'Task dependency graph contains a cycle');

    const normalizedTasks = order.map((id, position) => ({
      ...byId.get(id),
      position: position + 1
    }));

    return Object.freeze({
      schemaVersion: '0.1.0',
      type: 'task-plan',
      createdAt: this.clock().toISOString(),
      goal,
      taskCount: normalizedTasks.length,
      tasks: Object.freeze(normalizedTasks.map((task) => Object.freeze(task))),
      order: Object.freeze(order)
    });
  }
}

function normalizeTask(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw failure('TASK_INVALID', `Task at index ${index} must be an object`);
  const id = typeof task.id === 'string' ? task.id.trim() : '';
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  if (!id || !title) throw failure('TASK_INVALID', `Task at index ${index} requires id and title`);
  if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.some((value) => typeof value !== 'string' || !value.trim()))) {
    throw failure('TASK_DEPENDENCY_INVALID', `Task ${id} has invalid dependsOn`);
  }
  return {
    id,
    title,
    description: typeof task.description === 'string' ? task.description.trim() : '',
    dependsOn: [...new Set((task.dependsOn ?? []).map((value) => value.trim()))].sort(),
    agent: task.agent ?? null,
    priority: Number.isInteger(task.priority) ? task.priority : 0,
    input: task.input ?? null
  };
}

function topologicalOrder(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency).push(task.id);

  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => byId.get(a).priority - byId.get(b).priority || a.localeCompare(b));
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id).sort()) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  return order.length === tasks.length ? order : null;
}

function failure(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}
