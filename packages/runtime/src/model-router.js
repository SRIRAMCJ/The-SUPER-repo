export class ModelRouter {
  constructor({ models = [], clock = () => new Date() } = {}) {
    this.models = [...models];
    this.clock = clock;
  }

  register(model) {
    if (!model?.id) throw new TypeError('Model manifest requires id');
    if (this.models.some((candidate) => candidate.id === model.id)) {
      throw new Error(`Model already registered: ${model.id}`);
    }
    this.models.push(model);
    return model;
  }

  route(task = {}) {
    if (!task || typeof task !== 'object') throw new TypeError('Model routing task must be an object');
    const candidates = this.models
      .filter((model) => model.status !== 'disabled' && model.status !== 'deprecated')
      .filter((model) => supports(model, task))
      .map((model) => ({ model, score: score(model, task) }))
      .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));

    const selected = candidates[0] ?? null;
    return {
      schemaVersion: '0.1.0',
      type: 'model-route',
      createdAt: this.clock().toISOString(),
      task,
      selection: selected ? { modelId: selected.model.id, provider: selected.model.provider, score: selected.score } : null,
      candidates: candidates.map(({ model, score: modelScore }) => ({ modelId: model.id, provider: model.provider, score: modelScore }))
    };
  }
}

function supports(model, task) {
  if (task.capability && !(model.capabilities ?? []).includes(task.capability)) return false;
  if (task.mode && !(model.capabilities ?? []).includes(task.mode)) return false;
  if (task.minimumContextWindow && (model.contextWindow ?? 0) < task.minimumContextWindow) return false;
  return true;
}

function score(model, task) {
  let value = 0;
  const capabilities = model.capabilities ?? [];
  if (task.capability && capabilities.includes(task.capability)) value += 0.55;
  if (task.mode && capabilities.includes(task.mode)) value += 0.25;
  if (task.preferredProvider && model.provider === task.preferredProvider) value += 0.15;
  if (task.costSensitive && model.pricing) value += 0.05 / Math.max(1, model.pricing.inputPerMillionTokens ?? 1);
  return Math.min(1, value);
}
