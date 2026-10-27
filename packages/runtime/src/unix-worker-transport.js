import { createServer, createConnection } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LIMIT = 65_536;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

// One authenticated request per socket. The worker owns the handler registry;
// callers cannot send code or substitute a local callback across this boundary.
export class UnixWorkerServer {
  #server;
  #sockets = new Set();
  constructor({ socketPath, nodeId, authenticator, nonceStore, handlers, maxConcurrent = 32, maxBytes = LIMIT } = {}) {
    if (process.platform !== 'linux' || typeof socketPath !== 'string' || !socketPath.startsWith('/') ||
        !ID.test(nodeId) || typeof authenticator?.verifyWithStore !== 'function' || !nonceStore ||
        !handlers || typeof handlers !== 'object' || Array.isArray(handlers) ||
        Object.values(handlers).some((handler) => typeof handler !== 'function') ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > LIMIT) throw new TypeError('Invalid Unix worker configuration');
    Object.assign(this, { socketPath, nodeId, authenticator, nonceStore, handlers: Object.freeze({ ...handlers }), maxConcurrent, maxBytes });
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
      catch { this.#reply(socket, { error: { code: 'REMOTE_FRAME_INVALID' } }); return; }
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
      const { capabilityId, input } = body.payload;
      if (typeof capabilityId !== 'string' || !Object.hasOwn(this.handlers, capabilityId) ||
          !input || typeof input !== 'object' || Array.isArray(input)) throw fault('REMOTE_CAPABILITY_DENIED');
      const result = await this.handlers[capabilityId](structuredClone(input), { requestId: body.requestId, nodeId: body.nodeId });
      this.#reply(socket, { requestId: body.requestId, result });
    } catch (error) { this.#reply(socket, { error: { code: error?.code ?? 'REMOTE_WORKER_FAILED' } }); }
  }

  #reply(socket, value) {
    if (socket.destroyed) return;
    let frame;
    try { frame = Buffer.from(JSON.stringify(value) + '\n'); }
    catch { frame = Buffer.from('{"error":{"code":"REMOTE_RESULT_INVALID"}}\n'); }
    if (frame.length > this.maxBytes) frame = Buffer.from('{"error":{"code":"REMOTE_RESULT_TOO_LARGE"}}\n');
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

  async execute({ requestId = randomUUID(), capabilityId, input = {} } = {}) {
    if (!ID.test(capabilityId)) throw new TypeError('Invalid capability ID');
    const envelope = this.authenticator.sign({ requestId, nodeId: this.nodeId, payload: { capabilityId, input } });
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
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw.endsWith('\n')) throw fault('REMOTE_FRAME_INVALID');
          const response = JSON.parse(raw.slice(0, -1));
          if (response.error) return finish(fault(response.error.code));
          if (response.requestId !== requestId) throw fault('REMOTE_RESPONSE_MISMATCH');
          finish(null, response.result);
        } catch (error) { finish(error); }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => { if (!done) finish(fault('REMOTE_CONNECTION_CLOSED')); });
    });
  }
}

function fault(code) { return Object.assign(new Error(code), { code }); }
