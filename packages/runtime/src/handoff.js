import { createExecutionId } from './events.js';

export class HandoffProtocol {
  constructor({ maxPayloadBytes = 256 * 1024 } = {}) {
    this.maxPayloadBytes = maxPayloadBytes;
  }

  create({ fromAgent, toAgent, task, context = {}, input = {}, metadata = {} } = {}) {
    if (!fromAgent || !toAgent) throw new TypeError('Handoff requires fromAgent and toAgent');
    if (!task || typeof task !== 'string') throw new TypeError('Handoff requires a task');
    const handoff = {
      id: createExecutionId(),
      fromAgent,
      toAgent,
      task,
      input,
      context,
      metadata,
      createdAt: new Date().toISOString()
    };
    const bytes = Buffer.byteLength(JSON.stringify(handoff), 'utf8');
    if (bytes > this.maxPayloadBytes) throw Object.assign(new Error(`Handoff payload exceeds ${this.maxPayloadBytes} bytes`), { code: 'HANDOFF_PAYLOAD_TOO_LARGE' });
    return Object.freeze(handoff);
  }
}
