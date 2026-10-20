// One-shot, incident-scoped recovery. External effects must accept and enforce
// the epoch/token themselves; a state fence cannot undo an effect already made.
export class RuntimeFailoverKernel {
  #active = new Set();

  constructor({ supervisor, store, recover, owner, leaseMs = 30_000, renewEveryMs = 5_000, timeoutMs = 60_000 } = {}) {
    if (!supervisor || typeof supervisor.evaluate !== 'function' || !store || ['inspect', 'claim', 'renew', 'commit', 'release'].some((method) => typeof store[method] !== 'function')) throw new TypeError('supervisor and fenced store are required');
    if (typeof recover !== 'function' || typeof owner !== 'string' || !owner.trim()) throw new TypeError('recover() and owner are required');
    if (![leaseMs, renewEveryMs, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0) || leaseMs < 1000 || renewEveryMs >= leaseMs / 2) throw new TypeError('invalid failover deadlines');
    this.supervisor = supervisor;
    this.store = store;
    this.recover = recover;
    this.owner = owner;
    this.leaseMs = leaseMs;
    this.renewEveryMs = renewEveryMs;
    this.timeoutMs = timeoutMs;
  }

  async attempt(name, incidentId, { signal } = {}) {
    if (typeof name !== 'string' || !name.trim() || typeof incidentId !== 'string' || !incidentId.trim()) throw new TypeError('name and stable incidentId are required');
    const key = JSON.stringify([name, incidentId]);
    if (this.#active.has(key)) return { status: 'contended', name, incidentId };
    this.#active.add(key);
    try {
      if (signal?.aborted) return { status: 'cancelled', name, incidentId };
      const health = await this.supervisor.evaluate({ signal });
      if (health.state !== 'failed') return { status: 'skipped', name, incidentId, healthState: health.state };
      const previous = await this.store.inspect(key);
      if (previous?.result !== null && previous?.result !== undefined) return { status: 'completed', name, incidentId };
      let lease;
      try { lease = await this.store.claim(key, this.owner, this.leaseMs); }
      catch (error) { if (error?.code === 'FAILOVER_LEASE_HELD') return { status: 'contended', name, incidentId }; throw error; }
      if (lease.result !== null && lease.result !== undefined) {
        await this.store.release(key, lease);
        return { status: 'completed', name, incidentId };
      }
      return await this.#recover(key, lease, name, incidentId, signal);
    } finally { this.#active.delete(key); }
  }

  async #recover(key, lease, name, incidentId, parentSignal) {
    const controller = new AbortController();
    let lost = false, timer, timeout, settled = false;
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const abortWith = (code) => {
      const error = Object.assign(new Error(code), { code });
      controller.abort(error);
      rejectAbort(error);
    };
    const abort = () => abortWith('RECOVERY_CANCELLED');
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) abort();
    let renewing = Promise.resolve();
    const renew = () => {
      renewing = Promise.resolve().then(() => this.store.renew(key, lease, this.leaseMs)).catch(() => {
        lost = true;
        abortWith('FAILOVER_FENCE_REJECTED');
      }).then(() => { if (!lost && !settled) timer = setTimeout(renew, this.renewEveryMs); });
    };
    timer = setTimeout(renew, this.renewEveryMs);
    const fence = Object.freeze({ name, incidentId, epoch: lease.epoch, token: lease.token,
      assertCurrent: async () => {
        const current = await this.store.inspect(key);
        if (current?.token !== lease.token || current.epoch !== lease.epoch || current.expiresAt <= Date.now()) throw Object.assign(new Error('Failover fence lost'), { code: 'FAILOVER_FENCE_REJECTED' });
      } });
    try {
      const timedOut = new Promise((_, reject) => { timeout = setTimeout(() => {
        const error = Object.assign(new Error('Recovery timed out'), { code: 'RECOVERY_TIMEOUT' });
        reject(error);
        controller.abort(error);
      }, this.timeoutMs); });
      const recovered = await Promise.race([Promise.resolve().then(() => this.recover({ name, incidentId, fence, signal: controller.signal })), timedOut, cancelled]);
      await renewing;
      if (lost || controller.signal.aborted) throw Object.assign(new Error('Failover fence lost or cancelled'), { code: lost ? 'FAILOVER_FENCE_REJECTED' : 'RECOVERY_CANCELLED' });
      const committed = await this.store.commit(key, lease, { status: 'succeeded', output: recovered });
      return { status: 'succeeded', name, incidentId, epoch: lease.epoch, result: committed.result };
    } catch (error) {
      return { status: error?.code === 'FAILOVER_FENCE_REJECTED' ? 'fenced' : 'failed', name, incidentId, error: { code: error?.code ?? 'RECOVERY_FAILED' } };
    } finally {
      settled = true;
      clearTimeout(timer); clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
      await renewing;
      await this.store.release(key, lease).catch(() => {});
    }
  }
}
