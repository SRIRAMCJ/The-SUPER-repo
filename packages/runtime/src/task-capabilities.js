// Explicit capability order is executable pipeline order, not a sorted set.
export function taskCapabilities(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw invalid('Task must be an object');
  if (task.capabilities !== undefined && (!Array.isArray(task.capabilities) || task.capabilities.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw invalid(`Task ${task.id ?? ''} capabilities must be an array of non-empty strings`);
  }
  if (task.agent !== undefined && task.agent !== null && (typeof task.agent !== 'string' || !task.agent.trim())) {
    throw invalid(`Task ${task.id ?? ''} agent must be a non-empty string`);
  }
  if (task.capabilities?.length) return task.capabilities.map((id) => id.trim());
  return task.agent ? [task.agent.trim()] : [];
}

export function collectTaskCapabilities(tasks) {
  return [...new Set(tasks.flatMap(taskCapabilities))].sort();
}

function invalid(message) { return Object.assign(new TypeError(message), { code: 'TASK_CAPABILITY_INVALID', retryable: false }); }
