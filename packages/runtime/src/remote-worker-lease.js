const SCHEMA_VERSION = '0.1.0';
export const REMOTE_WORKER_LEASE_SCHEMA_VERSION = SCHEMA_VERSION;
const TERMINAL = new Set(['released','expired','cancelled']);

export class RemoteWorkerLeaseManager {
  #leases = new Map(); #clock; #ttlMs; #sequence = 0;
  constructor({ clock = () => Date.now(), ttlMs = 30_000 } = {}) {
    if (typeof clock !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('valid clock and positive ttlMs are required');
    this.#clock=clock; this.#ttlMs=ttlMs;
  }
  acquire({ executionId, workerId } = {}) {
    if (!executionId?.trim() || !workerId?.trim()) throw new TypeError('executionId and workerId are required');
    const now=this.#clock(); const existing=this.#findExecution(executionId);
    if (existing && !TERMINAL.has(existing.status)) return this.#result('conflict',{code:'LEASE_ALREADY_HELD',lease:existing});
    const lease=Object.freeze({schemaVersion:SCHEMA_VERSION,leaseId:`lease-${++this.#sequence}`,executionId,workerId,status:'active',acquiredAt:now,expiresAt:now+this.#ttlMs});
    this.#leases.set(lease.leaseId,lease); return this.#result('acquired',{lease});
  }
  renew(leaseId) {
    const lease=this.#leases.get(leaseId); if(!lease) return this.#result('not_found',{code:'LEASE_NOT_FOUND',leaseId});
    if(lease.status!=='active') return this.#result('expired',{code:'LEASE_NOT_ACTIVE',lease});
    const now=this.#clock(); if(now>=lease.expiresAt){const expired=Object.freeze({...lease,status:'expired',expiredAt:now});this.#leases.set(leaseId,expired);return this.#result('expired',{code:'LEASE_EXPIRED',lease:expired});}
    const next=Object.freeze({...lease,expiresAt:now+this.#ttlMs,lastRenewedAt:now});this.#leases.set(leaseId,next);return this.#result('renewed',{lease:next});
  }
  release(leaseId,status='released') {
    const lease=this.#leases.get(leaseId); if(!lease) return this.#result('not_found',{code:'LEASE_NOT_FOUND',leaseId});
    if(lease.status!=='active') return this.#result('already_terminal',{lease});
    const next=Object.freeze({...lease,status,releasedAt:this.#clock()});this.#leases.set(leaseId,next);return this.#result(status,{lease:next});
  }
  expire() {
    const now=this.#clock(); let count=0;
    for(const [id,lease] of this.#leases) if(lease.status==='active' && now>=lease.expiresAt){this.#leases.set(id,Object.freeze({...lease,status:'expired',expiredAt:now}));count++;}
    return Object.freeze({expired:count,leases:this.list()});
  }
  get(leaseId){const lease=this.#leases.get(leaseId);return lease?structuredClone(lease):null;}
  findByExecution(executionId){const lease=this.#findExecution(executionId);return lease?structuredClone(lease):null;}
  list(){return Object.freeze([...this.#leases.values()].map(x=>structuredClone(x)));}
  #findExecution(id){return [...this.#leases.values()].reverse().find(x=>x.executionId===id)??null;}
  #result(state,data){return Object.freeze({schemaVersion:SCHEMA_VERSION,state,...data});}
}
