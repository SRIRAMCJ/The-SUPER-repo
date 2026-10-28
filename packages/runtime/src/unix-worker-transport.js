import { createServer, createConnection } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const LIMIT = 65_536;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

// One authenticated request per socket. The worker owns the handler registry;
// callers cannot send code or substitute a local callback across this boundary.
export class UnixWorkerServer {
  #server;
  #sockets = new Set();
  constructor({ socketPath, nodeId, authenticator, nonceStore, handlers, authorize, auditJournal, idempotencyStore, effectStore = null, effects = {}, maxConcurrent = 32, maxBytes = LIMIT } = {}) {
    if (process.platform !== 'linux' || typeof socketPath !== 'string' || !socketPath.startsWith('/') ||
        !ID.test(nodeId) || typeof authenticator?.verifyWithStore !== 'function' || !nonceStore ||
        !handlers || typeof handlers !== 'object' || Array.isArray(handlers) ||
        Object.values(handlers).some((handler) => typeof handler !== 'function') ||
        typeof authorize !== 'function' || typeof auditJournal?.append !== 'function' ||
        typeof idempotencyStore?.claim !== 'function' || typeof idempotencyStore?.completeClaim !== 'function' ||
        !effects || typeof effects !== 'object' || Array.isArray(effects) ||
        Object.entries(effects).some(([id, destination]) => !Object.hasOwn(handlers, id) || typeof destination !== 'string' || !destination.startsWith('/')) ||
        (Object.keys(effects).length > 0 && typeof effectStore?.writeFencedJson !== 'function') ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > LIMIT) throw new TypeError('Invalid Unix worker configuration');
    Object.assign(this, { socketPath, nodeId, authenticator, nonceStore, handlers: Object.freeze({ ...handlers }),
      authorize, auditJournal, idempotencyStore, effectStore, effects: Object.freeze({ ...effects }), maxConcurrent, maxBytes });
  }

  async start() {
    if (this.#server) throw new Error('Worker already started');
    const directory = await lstat(path.dirname(this.socketPath));
    if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0)
      throw new Error('Worker socket directory must be owned by this process and private');
    try { await lstat(this.socketPath); throw new Error('Socket path already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.socketPath, resolve); });
      await chmod(this.socketPath, 0o600);
    } catch (error) { this.#server = null; server.close(); throw error; }
  }

  async stop() {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await unlink(this.socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  #accept(socket) {
    if (this.#sockets.size >= this.maxConcurrent) { socket.destroy(); return; }
    this.#sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    let chunks = [], bytes = 0, received = false;
    socket.on('data', (chunk) => {
      if (received) { socket.destroy(); return; }
      bytes += chunk.length;
      if (bytes > this.maxBytes) { socket.destroy(); return; }
      const line = chunk.indexOf(10);
      if (line === -1) { chunks.push(chunk); return; }
      if (line !== chunk.length - 1) { socket.destroy(); return; }
      received = true;
      chunks.push(chunk.subarray(0, line));
      let envelope;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { socket.destroy(); return; }
      chunks = [];
      void this.#execute(socket, envelope);
    });
    socket.on('error', () => {});
    socket.on('close', () => this.#sockets.delete(socket));
  }

  async #execute(socket, envelope) {
    try {
      const body = await this.authenticator.verifyWithStore(envelope, this.nonceStore);
      if (body.nodeId !== this.nodeId) throw fault('REMOTE_NODE_MISMATCH');
      const { capabilityId, input, fence } = body.payload;
      if (typeof capabilityId !== 'string' || !Object.hasOwn(this.handlers, capabilityId) ||
          !input || typeof input !== 'object' || Array.isArray(input)) throw fault('REMOTE_CAPABILITY_DENIED');
      const decision = await this.authorize({ capabilityId, nodeId: this.nodeId, requestId: body.requestId, input: structuredClone(input) });
      if (decision?.allowed !== true) throw fault('REMOTE_POLICY_DENIED');
      const destination = Object.hasOwn(this.effects, capabilityId) ? this.effects[capabilityId] : null;
      if (destination && (!fence || !ID.test(fence.key) || !Number.isSafeInteger(fence.epoch) ||
          fence.epoch < 1 || !ID.test(fence.token))) throw fault('REMOTE_FENCE_REQUIRED');
      const key = body.requestId;
      const fingerprint = createHash('sha256').update(JSON.stringify([this.nodeId, body.payload])).digest('hex');
      const claim = await this.idempotencyStore.claim(key, fingerprint);
      if (claim.state === 'replay') {
        const response = claim.record.response;
        this.#reply(socket, body, response);
        return;
      }
      if (claim.state !== 'claimed') throw fault({ conflict: 'REMOTE_REQUEST_CONFLICT', in_progress: 'REMOTE_IN_PROGRESS', recovery_required: 'REMOTE_RECOVERY_REQUIRED' }[claim.state] ?? 'REMOTE_CLAIM_INVALID');
      await this.auditJournal.append({ type: 'remote.worker.started', requestId: body.requestId, nodeId: this.nodeId, capabilityId });
      const context = { requestId: body.requestId, nodeId: body.nodeId };
      if (destination) context.writeEffect = (value) => this.effectStore.writeFencedJson(fence.key, fence, destination, value);
      let result;
      try {
        result = await this.handlers[capabilityId](structuredClone(input), context);
        let serialized;
        try { serialized = JSON.stringify({ result }); }
        catch { throw fault('REMOTE_RESULT_INVALID'); }
        result = JSON.parse(serialized).result;
        let response;
        try { response = JSON.stringify(this.authenticator.signResponse(body, { result })); }
        catch (error) { throw fault(error?.message === 'Request exceeds byte limit' ? 'REMOTE_RESULT_TOO_LARGE' : 'REMOTE_RESULT_INVALID'); }
        if (Buffer.byteLength(response) + 1 > this.maxBytes) throw fault('REMOTE_RESULT_TOO_LARGE');
      }
      catch (error) {
        const code = error?.code ?? 'REMOTE_WORKER_FAILED';
        await this.auditJournal.append({ type: 'remote.worker.failed', requestId: body.requestId, nodeId: this.nodeId, capabilityId, code });
        if (!await this.idempotencyStore.completeClaim(key, fingerprint, claim.record.claimToken, { error: { code } })) throw fault('REMOTE_RECOVERY_REQUIRED');
        this.#reply(socket, body, { error: { code } });
        return;
      }
      await this.auditJournal.append({ type: 'remote.worker.succeeded', requestId: body.requestId, nodeId: this.nodeId, capabilityId });
      if (!await this.idempotencyStore.completeClaim(key, fingerprint, claim.record.claimToken, { result })) throw fault('REMOTE_RECOVERY_REQUIRED');
      this.#reply(socket, body, { result });
    } catch (error) {
      // A failed terminal audit can follow a completed effect. The caller must
      // reconcile that uncertain outcome instead of blindly retrying it.
      this.#reply(socket, envelope?.body, { error: { code: error?.code ?? 'REMOTE_WORKER_FAILED' } });
    }
  }

  #reply(socket, request, value) {
    if (socket.destroyed) return;
    let frame;
    try { frame = Buffer.from(JSON.stringify(this.authenticator.signResponse(request, value)) + '\n'); }
    catch { socket.destroy(); return; }
    if (frame.length > this.maxBytes) {
      frame = Buffer.from(JSON.stringify(this.authenticator.signResponse(request, { error: { code: 'REMOTE_RESULT_TOO_LARGE' } })) + '\n');
    }
    socket.end(frame);
  }
}

export class UnixWorkerClient {
  constructor({ socketPath, nodeId, authenticator, timeoutMs = 30_000, maxBytes = LIMIT } = {}) {
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || !ID.test(nodeId) ||
        typeof authenticator?.sign !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > LIMIT) throw new TypeError('Invalid Unix worker client');
    Object.assign(this, { socketPath, nodeId, authenticator, timeoutMs, maxBytes });
  }

  async execute({ requestId = randomUUID(), capabilityId, input = {}, fence } = {}) {
    if (!ID.test(capabilityId)) throw new TypeError('Invalid capability ID');
    const envelope = this.authenticator.sign({ requestId, nodeId: this.nodeId, payload: { capabilityId, input, ...(fence === undefined ? {} : { fence }) } });
    const frame = Buffer.from(JSON.stringify(envelope) + '\n');
    if (frame.length > this.maxBytes) throw fault('REMOTE_FRAME_TOO_LARGE');
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let chunks = [], bytes = 0, done = false;
      const finish = (error, result) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve(result); };
      socket.setTimeout(this.timeoutMs, () => finish(fault('REMOTE_TIMEOUT')));
      socket.on('connect', () => socket.write(frame));
      socket.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxBytes) return finish(fault('REMOTE_RESULT_TOO_LARGE'));
        chunks.push(chunk);
      });
      socket.on('end', () => {
        try {
          if (bytes === 0) throw fault('REMOTE_CONNECTION_CLOSED');
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw.endsWith('\n')) throw fault('REMOTE_FRAME_INVALID');
          const response = this.authenticator.verifyResponse(JSON.parse(raw.slice(0, -1)), envelope.body);
          if (response.error) return finish(fault(response.error.code));
          finish(null, response.result);
        } catch (error) { finish(error); }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => { if (!done) finish(fault('REMOTE_CONNECTION_CLOSED')); });
    });
  }
}

function fault(code) { return Object.assign(new Error(code), { code }); }
