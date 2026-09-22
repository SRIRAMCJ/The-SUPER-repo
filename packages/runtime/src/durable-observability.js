import { appendFile, mkdir, readFile, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = '0.2.0';
export const DURABLE_OBSERVABILITY_SCHEMA_VERSION = SCHEMA_VERSION;
export const OBSERVABILITY_EVENT_STATES = Object.freeze(['accepted', 'duplicate', 'rejected']);

export class DurableObservabilityPipeline {
  #events = new Map(); #sequence = 0; #memoryTail = Promise.resolve(); #lockPath;
  constructor({ filePath = null, sourceId = 'runtime', clock = () => Date.now(), maxEvents = 50000, lockTimeoutMs = 5000, retryMs = 10, staleLockMs = 30000 } = {}) {
    this.filePath=filePath; this.sourceId=normalize(sourceId,'sourceId'); this.clock=clock; this.maxEvents=maxEvents; this.lockTimeoutMs=lockTimeoutMs; this.retryMs=retryMs; this.staleLockMs=staleLockMs;
    for (const [n,v] of [['maxEvents',maxEvents],['lockTimeoutMs',lockTimeoutMs],['retryMs',retryMs],['staleLockMs',staleLockMs]]) if (!Number.isInteger(v)||v<1) throw new TypeError(n+' must be a positive integer');
    if (filePath!==null && (typeof filePath!=='string'||!filePath.trim())) throw new TypeError('filePath must be null or a non-empty string');
    if (typeof clock!=='function') throw new TypeError('clock must be a function');
    this.#lockPath=filePath?filePath+'.lock':null; this.ready=filePath===null;
  }
  async init(){ if(this.ready)return this; await mkdir(dirname(this.filePath),{recursive:true}); await this.#reload(); this.ready=true; return this; }
  async record(event,{traceId=null,spanId=null,parentSpanId=null}={}) {
    this.#assertReady(); validateEvent(event);
    return this.#atomic(async()=>{ const now=this.clock(); const eventId=normalize(event.id??randomUUID(),'event.id'); const existing=this.#events.get(eventId); if(existing)return freeze({state:'duplicate',event:existing});
      const normalized={schemaVersion:SCHEMA_VERSION,eventId,sourceId:this.sourceId,sequence:this.#sequence+1,timestamp:normalizeTimestamp(event.timestamp,now),type:normalize(event.type,'event.type'),executionId:nullable(event.executionId,'executionId'),missionId:nullable(event.missionId,'missionId'),traceId:traceId===null?nullable(event.traceId,'traceId'):normalize(traceId,'traceId'),spanId:spanId===null?nullable(event.spanId,'spanId'):normalize(spanId,'spanId'),parentSpanId:parentSpanId===null?nullable(event.parentSpanId,'parentSpanId'):normalize(parentSpanId,'parentSpanId'),capabilityId:nullable(event.capabilityId,'capabilityId'),status:nullable(event.status,'status'),attributes:sanitizeAttributes(event.attributes)};
      normalized.integrity=hashEvent(normalized); await this.#append({op:'record',event:normalized}); this.#events.set(eventId,freeze(normalized)); this.#sequence=normalized.sequence; this.#enforceBound(); return freeze({state:'accepted',event:normalized});
    });
  }
  query({executionId=null,traceId=null,missionId=null,type=null,fromSequence=null,toSequence=null}={}) { this.#assertReady(); return [...this.#events.values()].filter(e=>executionId===null||e.executionId===executionId).filter(e=>traceId===null||e.traceId===traceId).filter(e=>missionId===null||e.missionId===missionId).filter(e=>type===null||e.type===type).filter(e=>fromSequence===null||e.sequence>=fromSequence).filter(e=>toSequence===null||e.sequence<=toSequence).sort((a,b)=>a.sequence-b.sequence).map(clone); }
  getSequence(){this.#assertReady();return this.#sequence;}
  checkpoint(){this.#assertReady();const values=[...this.#events.values()];return freeze({schemaVersion:SCHEMA_VERSION,type:'durable-observability-checkpoint',sourceId:this.sourceId,firstSequence:values[0]?.sequence??null,lastSequence:values.at(-1)?.sequence??null,retainedEvents:values.length,digest:digestEvents(values)});}
  verifyIntegrity(){this.#assertReady();const events=[...this.#events.values()].sort((a,b)=>a.sequence-b.sequence);let previous=0;for(const e of events){if(e.sequence!==previous+1)return freeze({valid:false,reason:'sequence_gap',expected:previous+1,actual:e.sequence});if(hashEvent(e)!==e.integrity)return freeze({valid:false,reason:'event_integrity_mismatch',sequence:e.sequence});previous=e.sequence;}return freeze({valid:true,firstSequence:events[0]?.sequence??null,lastSequence:events.at(-1)?.sequence??null,digest:digestEvents(events)});}
  snapshot(){this.#assertReady();return freeze({schemaVersion:SCHEMA_VERSION,type:'durable-observability',sourceId:this.sourceId,sequence:this.#sequence,retainedEvents:this.#events.size,integrity:this.verifyIntegrity()});}
  async #atomic(operation){ if(!this.filePath){const run=this.#memoryTail.then(operation,operation);this.#memoryTail=run.catch(()=>{});return run;} const deadline=this.clock()+this.lockTimeoutMs; while(true){try{await mkdir(this.#lockPath);try{await this.#reload();return await operation();}finally{await rm(this.#lockPath,{recursive:true,force:true});}}catch(error){if(error.code!=='EEXIST')throw error;let stale=false;try{stale=this.clock()-(await stat(this.#lockPath)).mtimeMs>=this.staleLockMs;}catch{}if(stale){await rm(this.#lockPath,{recursive:true,force:true});continue;}if(this.clock()>=deadline)throw errorCode('OBSERVABILITY_LOCK_TIMEOUT','Timed out acquiring observability lock',true);await new Promise(resolve=>setTimeout(resolve,this.retryMs));}}}
  async #reload(){this.#events.clear();this.#sequence=0;let text='';try{text=await readFile(this.filePath,'utf8');}catch(error){if(error.code!=='ENOENT')throw errorCode('OBSERVABILITY_REPLAY_FAILED',error.message,false);}for(const line of text.split('\n')){if(!line.trim())continue;let entry;try{entry=JSON.parse(line);}catch(error){throw errorCode('OBSERVABILITY_CORRUPT',error.message,false);}if(entry.schemaVersion!==SCHEMA_VERSION||entry.op!=='record'||!entry.event)throw errorCode('OBSERVABILITY_CORRUPT','Invalid observability journal entry',false);const e=entry.event;if(typeof e.sequence!=='number'||e.sequence!==this.#sequence+1||hashEvent(e)!==e.integrity)throw errorCode('OBSERVABILITY_CORRUPT','Invalid event sequence or integrity',false);this.#events.set(e.eventId,freeze(e));this.#sequence=e.sequence;}this.#enforceBound();}
  async #append(entry){if(!this.filePath)return;await appendFile(this.filePath,JSON.stringify({schemaVersion:SCHEMA_VERSION,...entry})+'\n','utf8');const handle=await open(this.filePath,'r');try{await handle.sync();}finally{await handle.close();}}
  #enforceBound(){while(this.#events.size>this.maxEvents){const first=this.#events.values().next().value;if(!first)break;this.#events.delete(first.eventId);}}
  #assertReady(){if(!this.ready)throw new Error('DurableObservabilityPipeline.init() must be awaited before use when filePath is configured');}
}
function validateEvent(e){if(!e||typeof e!=='object'||Array.isArray(e))throw new TypeError('event must be an object');if(typeof e.type!=='string'||!e.type.trim())throw new TypeError('event.type is required');}
function normalize(v,n){if(typeof v!=='string'||!v.trim()||v.trim().length>512)throw new TypeError(n+' must be a non-empty string <=512 chars');return v.trim();}
function nullable(v,n){return v==null?null:normalize(v,n);}
function normalizeTimestamp(v,now){if(v==null)return new Date(now).toISOString();if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))throw new TypeError('event.timestamp must be an ISO timestamp');return v;}
function sanitizeAttributes(v){if(v==null)return Object.freeze({});if(!v||typeof v!=='object'||Array.isArray(v))throw new TypeError('event.attributes must be an object');return freeze(JSON.parse(JSON.stringify(v)));}
function canonicalize(v){if(v===undefined||typeof v==='function'||typeof v==='symbol')throw new TypeError('observability value must be JSON-like');if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonicalize).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalize(v[k])).join(',')+'}';}
function hashEvent(e){const copy={...e};delete copy.integrity;return createHash('sha256').update(canonicalize(copy)).digest('hex');}
function digestEvents(events){return createHash('sha256').update(canonicalize(events.map(e=>e.integrity))).digest('hex');}
function clone(v){return structuredClone(v);} function freeze(v){return deepFreeze(structuredClone(v));} function deepFreeze(v){if(!v||typeof v!=='object'||Object.isFrozen(v))return v;for(const child of Object.values(v))deepFreeze(child);return Object.freeze(v);} function errorCode(code,message,retryable){return Object.assign(new Error(message),{code,retryable});}