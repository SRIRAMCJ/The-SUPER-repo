import { createServer, connect, checkServerIdentity } from 'node:tls';
import { createConnection } from 'node:net';
import { UnixWorkerClient } from './unix-worker-transport.js';

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const LIMIT = 65_536;

// Mutual TLS gateway to the local governed worker. The worker still validates
// each signed request, policy decision, durable claim, and effect fence.
export class TlsWorkerBridge {
  #server;
  #sockets = new Set();
  constructor({ host = '0.0.0.0', port, socketPath, key, cert, ca, clientFingerprints,
    maxConnections = 32, maxBytes = LIMIT, timeoutMs = 30_000 } = {}) {
    if (typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 0 || port > 65535 ||
        typeof socketPath !== 'string' || !socketPath.startsWith('/') || !key || !cert || !ca ||
        !Array.isArray(clientFingerprints) || clientFingerprints.length < 1 ||
        clientFingerprints.some((value) => typeof value !== 'string' || !FINGERPRINT.test(value)) ||
        !Number.isSafeInteger(maxConnections) || maxConnections < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > LIMIT ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid TLS worker bridge configuration');
    Object.assign(this, { host, port, socketPath, key, cert, ca, clientFingerprints: new Set(clientFingerprints),
      maxConnections, maxBytes, timeoutMs });
  }

  async start() {
    if (this.#server) throw new Error('TLS worker bridge already started');
    const server = createServer({ key: this.key, cert: this.cert, ca: this.ca, requestCert: true,
      rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (socket) => this.#accept(socket));
    this.#server = server;
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, this.host, resolve); }); }
    catch (error) { this.#server = null; server.close(); throw error; }
  }

  async stop() {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  address() { return this.#server?.address() ?? null; }

  #accept(socket) {
    if (!socket.authorized || !this.clientFingerprints.has(socket.getPeerCertificate().fingerprint256) ||
        this.#sockets.size >= this.maxConnections * 2) { socket.destroy(); return; }
    const worker = createConnection(this.socketPath);
    this.#sockets.add(socket);
    this.#sockets.add(worker);
    let sent = 0, received = 0;
    const close = () => { socket.destroy(); worker.destroy(); };
    for (const peer of [socket, worker]) { peer.setTimeout(this.timeoutMs, close); peer.on('error', close); }
    socket.on('close', () => { this.#sockets.delete(socket); worker.destroy(); });
    worker.on('close', () => { this.#sockets.delete(worker); socket.end(); });
    socket.on('data', (chunk) => {
      sent += chunk.length;
      if (sent > this.maxBytes) { close(); return; }
      if (!worker.write(chunk)) socket.pause();
    });
    worker.on('drain', () => socket.resume());
    worker.on('data', (chunk) => {
      received += chunk.length;
      if (received > this.maxBytes) { close(); return; }
      if (!socket.write(chunk)) worker.pause();
    });
    socket.on('drain', () => worker.resume());
    socket.on('end', () => worker.end());
    worker.on('end', () => socket.end());
  }
}

export class TlsWorkerClient {
  constructor({ host, port, servername, serverFingerprint256, key, cert, ca, nodeId, authenticator,
    timeoutMs = 30_000, maxBytes = LIMIT } = {}) {
    if (typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        typeof servername !== 'string' || !servername || !FINGERPRINT.test(serverFingerprint256) ||
        !key || !cert || !ca) throw new TypeError('Invalid TLS worker client configuration');
    this.client = new UnixWorkerClient({ socketPath: '/tls-worker', nodeId, authenticator, timeoutMs, maxBytes,
      connectSocket: () => connect({ host, port, servername, key, cert, ca, rejectUnauthorized: true,
        minVersion: 'TLSv1.3', checkServerIdentity: (name, peer) => {
          const error = checkServerIdentity(name, peer);
          return error ?? (peer.fingerprint256 === serverFingerprint256 ? undefined : new Error('TLS worker certificate fingerprint mismatch'));
        } }) });
  }

  execute(request) { return this.client.execute(request); }
}
