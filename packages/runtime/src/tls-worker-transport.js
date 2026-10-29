import { createServer, connect, checkServerIdentity } from 'node:tls';
import { createConnection } from 'node:net';
import { UnixWorkerClient } from './unix-worker-transport.js';

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const LIMIT = 65_536;
const MAX_PINS = 16;

function fingerprintSet(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PINS ||
      values.some((value) => typeof value !== 'string' || !FINGERPRINT.test(value)) ||
      new Set(values).size !== values.length) throw new TypeError('Invalid TLS certificate fingerprints');
  return new Set(values);
}

// Mutual TLS gateway to the local governed worker. The worker still validates
// each signed request, policy decision, durable claim, and effect fence.
export class TlsWorkerBridge {
  #server;
  #sockets = new Set();
  constructor({ host = '0.0.0.0', port, socketPath, key, cert, ca, clientFingerprints,
    maxConnections = 32, maxBytes = LIMIT, timeoutMs = 30_000 } = {}) {
    if (typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 0 || port > 65535 ||
        typeof socketPath !== 'string' || !socketPath.startsWith('/') || !key || !cert || !ca ||
        !Number.isSafeInteger(maxConnections) || maxConnections < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > LIMIT ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid TLS worker bridge configuration');
    this.#clientFingerprints = fingerprintSet(clientFingerprints);
    Object.assign(this, { host, port, socketPath, key, cert, ca,
      maxConnections, maxBytes, timeoutMs });
  }

  #clientFingerprints;

  // Swap the allowlist for new connections. Existing requests finish under their
  // authenticated TLS session; stop the bridge to terminate them immediately.
  rotateClientFingerprints(values) { this.#clientFingerprints = fingerprintSet(values); }

  async start() {
    if (this.#server) throw new Error('TLS worker bridge already started');
    const server = createServer({ key: this.key, cert: this.cert, ca: this.ca, requestCert: true,
      rejectUnauthorized: true, minVersion: 'TLSv1.3', handshakeTimeout: this.timeoutMs }, (socket) => this.#accept(socket));
    // net.Server accounts for TCP sockets before TLS authentication finishes.
    server.maxConnections = this.maxConnections;
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
    if (!socket.authorized || !this.#clientFingerprints.has(socket.getPeerCertificate().fingerprint256) ||
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
  constructor({ host, port, servername, serverFingerprint256, serverFingerprints256, key, cert, ca, nodeId, authenticator,
    timeoutMs = 30_000, maxBytes = LIMIT } = {}) {
    if (typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        typeof servername !== 'string' || !servername ||
        !key || !cert || !ca) throw new TypeError('Invalid TLS worker client configuration');
    if (serverFingerprint256 !== undefined && serverFingerprints256 !== undefined)
      throw new TypeError('Specify one TLS server fingerprint option');
    const trustedPins = fingerprintSet(serverFingerprints256 ?? [serverFingerprint256]);
    this.client = new UnixWorkerClient({ socketPath: '/tls-worker', nodeId, authenticator, timeoutMs, maxBytes,
      connectSocket: () => connect({ host, port, servername, key, cert, ca, rejectUnauthorized: true,
        minVersion: 'TLSv1.3', checkServerIdentity: (name, peer) => {
          const error = checkServerIdentity(name, peer);
          return error ?? (trustedPins.has(peer.fingerprint256) ? undefined : new Error('TLS worker certificate fingerprint mismatch'));
        } }) });
  }

  execute(request) { return this.client.execute(request); }
}
