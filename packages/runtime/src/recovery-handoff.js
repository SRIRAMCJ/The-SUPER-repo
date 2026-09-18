const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['offered', 'accepted', 'executing', 'completed', 'rejected', 'expired', 'cancelled']);

export class RecoveryHandoffKernel {
  #handoffs = new Map();
  #history = [];

  constructor({ lease, clock = () => new Date(), idFactory = defaultId, handoffTtlMs = 30_000, maxHistory = 256 } = {}) {
    if (!lease || typeof lease.acquire !== 'function' || typeof lease.release !== 'function' || typeof lease.validate !== 'function') throw new TypeError('lease must expose acquire(), release() and validate()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(handoffTtlMs) || handoffTtlMs < 1) throw new TypeError('handoffTtlMs must be positive');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be positive');
    this.lease=lease; this.clock=clock; this.idFactory=idFactory; this.handoffTtlMs=handoffTtlMs; this.maxHistory=maxHistory;
  }

  offer({ transactionId, sourceNodeId, targetNodeId, reason='failover', signal=null }={}) {
    this.#validateIds(transactionId, sourceNodeId, targetNodeId);
    if (signal?.aborted) throw error('RECOVERY_HANDOFF_CANCELLED','Handoff cancelled before offer');
    if (sourceNodeId === targetNodeId) throw error('RECOVERY_HANDOFF_SAME_NODE','Source and target nodes must differ');
    const existing=this.#handoffs.get(transactionId);
    if (existing && ['offered','accepted','executing'].includes(existing.state)) throw error('RECOVERY_HANDOFF_IN_PROGRESS','A handoff is already active');
    const handoff=freeze({schemaVersion:SCHEMA_VERSION,handoffId:this.idFactory('recovery-handoff'),transactionId,sourceNodeId,targetNodeId,reason,state:'offered',createdAt:this.nowIso(),expiresAt:new Date(this.clock().getTime()+this.handoffTtlMs).toISOString(),fencingToken:null,acceptedAt:null,completedAt:null});
    this.#handoffs.set(transactionId,handoff); this.#record('handoff_offered',handoff); return clone(handoff);
  }

  accept({ transactionId, targetNodeId, ownerId, signal=null }={}) {
    if (signal?.aborted) throw error('RECOVERY_HANDOFF_CANCELLED','Handoff cancelled before acceptance');
    const current=this.#require(transactionId);
    this.#expireIfNeeded(current);
    if (current.state !== 'offered') throw error('RECOVERY_HANDOFF_NOT_OFFERED','Handoff is not awaiting acceptance');
    if (targetNodeId !== current.targetNodeId) throw error('RECOVERY_HANDOFF_TARGET_MISMATCH','Target node does not match handoff');
    const lease=awaitable(this.lease.acquire({executionId:transactionId,ownerId,nodeId:targetNodeId,signal,reason:'recovery_handoff'}));
    const accepted=freeze({...current,state:'accepted',fencingToken:lease.fencingToken,acceptedAt:this.nowIso()});
    this.#handoffs.set(transactionId,accepted); this.#record('handoff_accepted',accepted); return {handoff:clone(accepted),lease};
  }

  beginExecution({ transactionId, targetNodeId, fencingToken, signal=null }={}) {
    if (signal?.aborted) throw error('RECOVERY_HANDOFF_CANCELLED','Handoff cancelled before execution');
    const current=this.#require(transactionId);
    this.#expireIfNeeded(current);
    if (current.state !== 'accepted') throw error('RECOVERY_HANDOFF_NOT_ACCEPTED','Handoff must be accepted before execution');
    this.#validateFence(current,targetNodeId,fencingToken);
    const next=freeze({...current,state:'executing'});
    this.#handoffs.set(transactionId,next); this.#record('handoff_executing',next); return clone(next);
  }

  complete({ transactionId, targetNodeId, fencingToken, status='succeeded', result=null }={}) {
    const current=this.#require(transactionId);
    this.#validateFence(current,targetNodeId,fencingToken);
    if (current.state !== 'executing') throw error('RECOVERY_HANDOFF_NOT_EXECUTING','Handoff is not executing');
    const terminal=['succeeded','failed','cancelled'].includes(status) ? 'completed' : null;
    if (!terminal) throw new TypeError('status must be succeeded, failed or cancelled');
    const next=freeze({...current,state:terminal,completionStatus:status,result:clone(result),completedAt:this.nowIso()});
    this.#handoffs.set(transactionId,next); this.#record('handoff_completed',next); return clone(next);
  }

  cancel({ transactionId, targetNodeId, fencingToken, reason='cancelled' }={}) {
    const current=this.#require(transactionId);
    this.#validateFence(current,targetNodeId,fencingToken);
    if (!['offered','accepted','executing'].includes(current.state)) throw error('RECOVERY_HANDOFF_NOT_ACTIVE','Handoff is not active');
    const next=freeze({...current,state:'cancelled',cancelReason:reason,completedAt:this.nowIso()});
    this.#handoffs.set(transactionId,next); this.#record('handoff_cancelled',next); return clone(next);
  }

  get(transactionId) { const current=this.#handoffs.get(transactionId); if (current) this.#expireIfNeeded(current); return clone(this.#handoffs.get(transactionId) ?? null); }
  list() { for (const item of this.#handoffs.values()) this.#expireIfNeeded(item); return [...this.#handoffs.values()].map(clone); }
  history() { return deepFreeze(this.#history.map(clone)); }
  snapshot() { return freeze({schemaVersion:SCHEMA_VERSION,type:'recovery-handoff-kernel',handoffs:this.list(),history:this.history()}); }

  #require(transactionId) { if (typeof transactionId !== 'string' || !transactionId) throw new TypeError('transactionId is required'); const value=this.#handoffs.get(transactionId); if (!value) throw error('RECOVERY_HANDOFF_NOT_FOUND','Recovery handoff not found'); return value; }
  #validateIds(transactionId,sourceNodeId,targetNodeId) { if (![transactionId,sourceNodeId,targetNodeId].every(x=>typeof x==='string'&&x)) throw new TypeError('transactionId, sourceNodeId and targetNodeId are required'); }
  #validateFence(current,targetNodeId,fencingToken) { if (targetNodeId!==current.targetNodeId) throw error('RECOVERY_HANDOFF_TARGET_MISMATCH','Target node does not match handoff'); if (fencingToken!==current.fencingToken) throw error('RECOVERY_HANDOFF_STALE_FENCE','Stale fencing token'); }
  #expireIfNeeded(current) { if (!['offered','accepted'].includes(current.state)) return; if (this.clock().getTime() < Date.parse(current.expiresAt)) return; const next=freeze({...current,state:'expired',completedAt:this.nowIso()}); this.#handoffs.set(current.transactionId,next); this.#record('handoff_expired',next); }
  #record(event,data) { this.#history.push(freeze({schemaVersion:SCHEMA_VERSION,eventId:this.idFactory('recovery-handoff-event'),event,timestamp:this.nowIso(),data:clone(data)})); while(this.#history.length>this.maxHistory)this.#history.shift(); }
  nowIso(){const value=this.clock();if(!(value instanceof Date)||Number.isNaN(value.getTime()))throw new TypeError('clock must return a valid Date');return value.toISOString();}
}

function awaitable(value){ if (value && typeof value.then==='function') throw error('RECOVERY_HANDOFF_ASYNC_LEASE_UNSUPPORTED','Handoff acceptance requires a synchronous lease primitive'); return value; }
function error(code,message){return Object.assign(new Error(message),{code,retryable:false});}
function clone(value){return value==null?value:structuredClone(value);}
function freeze(value){return deepFreeze(structuredClone(value));}
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
function defaultId(prefix){return prefix+'-'+Date.now().toString(36);}
export { SCHEMA_VERSION as RECOVERY_HANDOFF_SCHEMA_VERSION, STATES as RECOVERY_HANDOFF_STATES };
