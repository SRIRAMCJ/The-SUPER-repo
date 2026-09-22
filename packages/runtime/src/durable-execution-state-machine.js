const SCHEMA_VERSION = '0.1.0';

export const DURABLE_EXECUTION_STATE_MACHINE_SCHEMA_VERSION = SCHEMA_VERSION;

export const EXECUTION_LIFECYCLE_STATES = Object.freeze([
  'created',
  'admitted',
  'prepared',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'recovered',
]);

const TRANSITIONS = new Map([
  ['created', new Set(['admitted', 'cancelled', 'failed'])],
  ['admitted', new Set(['prepared', 'cancelled', 'failed'])],
  ['prepared', new Set(['running', 'cancelled', 'failed'])],
  ['running', new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])],
  ['failed', new Set(['recovered'])],
  ['timed_out', new Set(['recovered'])],
  ['recovered', new Set(['prepared', 'running', 'cancelled', 'failed'])],
  ['succeeded', new Set()],
  ['cancelled', new Set()],
]);

export class DurableExecutionStateMachine {
  #store;
  #clock;
  #hooks;

  constructor({ store, clock = () => new Date().toISOString(), hooks = {} } = {}) {
    if (!store || typeof store.create !== 'function' || typeof store.get !== 'function' || typeof store.update !== 'function') {
      throw new TypeError('store must expose create(), get(), and update()');
    }
    this.#store = store;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  async create({ executionId, type = 'execution', metadata = {}, initialState = 'created' } = {}) {
    assertState(initialState);
    if (initialState !== 'created') throw new TypeError('initialState must be created');
    return this.#store.create({
      executionId,
      type,
      state: 'created',
      metadata: structuredClone(metadata),
      transitionCount: 0,
      lastError: null,
      createdAt: this.#clock(),
      updatedAt: this.#clock(),
    });
  }

  async transition(executionId, nextState, { expectedVersion = null, reason = null, metadata = undefined, error = undefined } = {}) {
    assertState(nextState);
    const current = await this.#store.get(executionId);
    if (!current) throw Object.assign(new Error(`Execution state not found: ${executionId}`), { code: 'EXECUTION_STATE_NOT_FOUND', retryable: false });
    if (current.state === nextState) throw Object.assign(new Error(`Execution is already in state: ${nextState}`), { code: 'EXECUTION_STATE_NOOP', retryable: false });
    if (!TRANSITIONS.get(current.state)?.has(nextState)) {
      throw Object.assign(new Error(`Invalid execution transition: ${current.state} -> ${nextState}`), {
        code: 'INVALID_EXECUTION_TRANSITION',
        retryable: false,
        from: current.state,
        to: nextState,
      });
    }
    const patch = {
      state: nextState,
      transitionCount: current.transitionCount + 1,
      lastTransition: { from: current.state, to: nextState, at: this.#clock(), reason },
      ...(metadata !== undefined ? { metadata: structuredClone(metadata) } : {}),
      ...(error !== undefined ? { lastError: structuredClone(error) } : {}),
    };
    const updated = await this.#store.update(executionId, patch, expectedVersion ?? current.version);
    await this.#hooks.onTransition?.({ previous: current, next: updated });
    return updated;
  }

  async recover(executionId, { expectedVersion = null, targetState = 'recovered', reason = 'recovery' } = {}) {
    const current = await this.#store.get(executionId);
    if (!current) throw Object.assign(new Error(`Execution state not found: ${executionId}`), { code: 'EXECUTION_STATE_NOT_FOUND', retryable: false });
    if (!['failed', 'timed_out'].includes(current.state)) {
      throw Object.assign(new Error(`Execution cannot recover from state: ${current.state}`), { code: 'EXECUTION_NOT_RECOVERABLE', retryable: false });
    }
    return this.transition(executionId, targetState, { expectedVersion: expectedVersion ?? current.version, reason });
  }

  async snapshot(executionId) {
    return this.#store.get(executionId);
  }

  async isTerminal(executionId) {
    const state = await this.#store.get(executionId);
    return state ? ['succeeded', 'cancelled'].includes(state.state) : false;
  }
}

export function isValidExecutionTransition(from, to) {
  return Boolean(TRANSITIONS.get(from)?.has(to));
}

export function allowedExecutionTransitions(from) {
  assertState(from);
  return Object.freeze([...(TRANSITIONS.get(from) ?? [])]);
}

function assertState(state) {
  if (!EXECUTION_LIFECYCLE_STATES.includes(state)) throw new TypeError(`Unsupported execution state: ${state}`);
}
