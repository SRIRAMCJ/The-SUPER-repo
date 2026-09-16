import { createExecutionId } from './events.js';

export class AdaptiveAgentRuntime {
  constructor({ agentRuntime, modelRouter = null, modelRuntime = null, reflection = null, events = null, clock = () => new Date() } = {}) {
    if (!agentRuntime) throw new TypeError('AdaptiveAgentRuntime requires agentRuntime');
    this.agentRuntime = agentRuntime;
    this.modelRouter = modelRouter;
    this.modelRuntime = modelRuntime;
    this.reflection = reflection;
    this.events = events;
    this.clock = clock;
  }

  async execute(request, input = {}, context = {}, options = {}) {
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    this.events?.emit({ type: 'adaptive.started', executionId, status: 'started', data: { request } });

    try {
      const plan = this.agentRuntime.plan(request, options.agent ?? {});
      if (!plan.selection) return this.#fail(executionId, startedAt, 'NO_AGENT_MATCH', 'No registered agent matched the request', plan);

      let route = null;
      let model = null;
      if (options.modelTask && this.modelRouter) {
        route = this.modelRouter.route(options.modelTask);
        if (!route.selection) return this.#fail(executionId, startedAt, 'NO_MODEL_MATCH', 'No compatible model matched the task', plan, { route });
        if (options.generate && this.modelRuntime) {
          model = await this.modelRuntime.generate({
            provider: route.selection.provider,
            model: route.selection.modelId,
            mode: options.modelTask.mode ?? 'chat',
            input: options.generateInput ?? input,
            signal: context.signal
          });
        }
      }

      const enrichedContext = model ? { ...context, model } : context;
      const result = await this.agentRuntime.executeRequest(request, input, enrichedContext, options.agent ?? {});
      const reflection = this.reflection
        ? await this.reflection.evaluate({ request, plan, result, context: enrichedContext })
        : null;

      const output = {
        executionId,
        startedAt,
        finishedAt: this.clock().toISOString(),
        status: reflection?.status === 'rejected' ? 'failed' : result.status,
        plan,
        route,
        model,
        reflection,
        result
      };
      this.events?.emit({
        type: output.status === 'succeeded' ? 'adaptive.completed' : 'adaptive.failed',
        executionId,
        status: output.status,
        data: output,
        error: output.status === 'failed' ? { code: 'ADAPTIVE_EXECUTION_FAILED', message: reflection?.status === 'rejected' ? 'Reflection rejected the result' : 'Agent execution failed' } : undefined
      });
      return output;
    } catch (error) {
      return this.#fail(executionId, startedAt, error?.code ?? 'ADAPTIVE_ERROR', error?.message ?? String(error));
    }
  }

  #fail(executionId, startedAt, code, message, plan = null, extra = {}) {
    const result = {
      executionId,
      startedAt,
      finishedAt: this.clock().toISOString(),
      status: 'failed',
      error: { code, message, retryable: false },
      plan,
      ...extra
    };
    this.events?.emit({ type: 'adaptive.failed', executionId, status: 'failed', error: result.error, data: result });
    return result;
  }
}
