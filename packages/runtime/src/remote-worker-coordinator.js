import { createHash } from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

// Single-host coordinator for a stable request. The worker's durable request
// ledger, rather than the transport timeout, determines whether retry is safe.
export class RemoteWorkerCoordinator {
  constructor({ nodeId, client, leaseStore, leaseMs = 30_000 } = {}) {
    if (!ID.test(nodeId) || typeof client?.execute !== 'function' || typeof leaseStore?.claim !== 'function' ||
        typeof leaseStore?.commit !== 'function' || typeof leaseStore?.inspect !== 'function' ||
        typeof leaseStore?.release !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1000)
      throw new TypeError('Invalid remote worker coordinator');
    Object.assign(this, { nodeId, client, leaseStore, leaseMs });
  }

  async execute({ executionId, requestId, capabilityId, input = {} } = {}) {
    if (!ID.test(executionId) || !ID.test(requestId) || !ID.test(capabilityId) ||
        !input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid remote execution');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = await this.leaseStore.inspect(executionId);
    if (existing?.result !== null && existing?.result !== undefined) {
      if (existing.result.requestId !== requestId || existing.result.capabilityId !== capabilityId || existing.result.fingerprint !== fingerprint)
        throw fault('REMOTE_EXECUTION_CONFLICT');
      return structuredClone(existing.result.value);
    }
    const identity = createHash('sha256').update(JSON.stringify([requestId, capabilityId, fingerprint])).digest('hex');
    if (existing && existing.identity !== identity) throw fault('REMOTE_EXECUTION_CONFLICT');
    const lease = await this.leaseStore.claim(executionId, this.nodeId, this.leaseMs, identity);
    const fence = { key: executionId, epoch: lease.epoch, token: lease.token };
    try {
      const value = await this.client.execute({ requestId, capabilityId, input, fence });
      await this.leaseStore.commit(executionId, lease, { requestId, capabilityId, fingerprint, value });
      await this.leaseStore.release(executionId, lease);
      return value;
    } catch (error) {
      // A transport failure can follow an effect. Keep ownership until expiry;
      // the worker's pending claim blocks blind re-execution after takeover.
      throw error;
    }
  }
}

function fault(code) { return Object.assign(new Error(code), { code }); }

