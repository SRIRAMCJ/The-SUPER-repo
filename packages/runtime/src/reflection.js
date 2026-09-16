export class ReflectionEngine {
  constructor({ critics = [], clock = () => new Date() } = {}) {
    this.critics = [...critics];
    this.clock = clock;
  }

  register(critic) {
    if (!critic || typeof critic.id !== 'string' || typeof critic.evaluate !== 'function') {
      throw new TypeError('Critic requires id and evaluate()');
    }
    if (this.critics.some((candidate) => candidate.id === critic.id)) {
      throw new Error(`Critic already registered: ${critic.id}`);
    }
    this.critics.push(critic);
    return critic;
  }

  async evaluate({ request = null, plan = null, result = null, context = {} } = {}) {
    const startedAt = this.clock().toISOString();
    const evaluations = [];
    for (const critic of this.critics) {
      const value = await critic.evaluate({ request, plan, result, context });
      evaluations.push(normalizeEvaluation(critic.id, value));
    }
    const rejected = evaluations.filter((evaluation) => evaluation.status === 'rejected');
    const warnings = evaluations.filter((evaluation) => evaluation.status === 'warning');
    return {
      schemaVersion: '0.1.0',
      type: 'reflection-result',
      createdAt: startedAt,
      status: rejected.length ? 'rejected' : warnings.length ? 'warning' : 'accepted',
      evaluations,
      summary: { critics: evaluations.length, rejected: rejected.length, warnings: warnings.length }
    };
  }
}

export function createBasicOutputCritic({ id = 'critic/output-shape' } = {}) {
  return {
    id,
    async evaluate({ result }) {
      if (!result || typeof result !== 'object') return { status: 'rejected', reason: 'Result must be an object' };
      if (!result.status) return { status: 'rejected', reason: 'Result is missing status' };
      if (result.status === 'failed' && !result.error) return { status: 'rejected', reason: 'Failed result must include error' };
      return { status: 'accepted', reason: 'Result shape is valid' };
    }
  };
}

function normalizeEvaluation(criticId, value) {
  const status = value?.status ?? 'warning';
  if (!['accepted', 'warning', 'rejected'].includes(status)) {
    throw new Error(`Critic ${criticId} returned invalid status: ${status}`);
  }
  return { criticId, status, reason: value?.reason ?? null, details: value?.details ?? null };
}
