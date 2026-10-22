import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { RuntimeOperations } from './operations.js';
import { RuntimeCommandBus } from './command-bus.js';

const SCHEMA_VERSION = '0.1.0';

export class ControlPlaneGateway {
  constructor({ controlPlane, operations = null, commands = null, authorize = null, maxBodyBytes = 65536, shutdownAdmission = null, requestGuard = null, preAuthLimiter = null } = {}) {
    if (!controlPlane || typeof controlPlane.getHealth !== 'function' || typeof controlPlane.snapshot !== 'function') throw new TypeError('ControlPlaneGateway requires a compatible runtime control plane');
    if (operations && typeof operations.getOperations !== 'function') throw new TypeError('operations must expose getOperations()');
    if (commands && typeof commands.list !== 'function' || commands && typeof commands.execute !== 'function') throw new TypeError('commands must expose list() and execute()');
    if (authorize !== null && typeof authorize !== 'function') throw new TypeError('authorize must be a function');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new TypeError('maxBodyBytes must be an integer >= 1024');
    if (shutdownAdmission && (typeof shutdownAdmission.admit !== 'function' || typeof shutdownAdmission.release !== 'function')) throw new TypeError('shutdownAdmission must expose admit() and release()');
    if (requestGuard && (typeof requestGuard.admit !== 'function' || typeof requestGuard.complete !== 'function')) throw new TypeError('requestGuard must expose admit() and complete()');
    if (preAuthLimiter && typeof preAuthLimiter.consume !== 'function') throw new TypeError('preAuthLimiter must expose consume()');
    this.controlPlane = controlPlane;
    this.operations = operations ?? new RuntimeOperations({ controlPlane });
    this.commands = commands ?? new RuntimeCommandBus({ controlPlane, operations: this.operations });
    this.authorize = authorize ?? (() => true);
    this.explicitAuthorization = authorize !== null;
    this.requireAuthenticatedIdentity = false;
    this.maxBodyBytes = maxBodyBytes;
    this.shutdownAdmission = shutdownAdmission;
    this.requestGuard = requestGuard;
    this.preAuthLimiter = preAuthLimiter;
    this.server = null;
  }

  async handle(request) {
    if (!request || typeof request !== 'object') return failure(400, 'INVALID_REQUEST', 'Request must be an object');
    const method = String(request.method ?? 'GET').toUpperCase();
    const rawPath = String(request.path ?? '/');
    const parsed = new URL(rawPath, 'http://super.local');
    const route = parsed.pathname.replace(/\/+$/, '') || '/';
    if (this.preAuthLimiter) {
      let decision;
      try { decision = await this.preAuthLimiter.consume(`preauth:${String(request.remoteAddress ?? 'unknown').slice(0, 240)}`); }
      catch { return failure(503, 'PRE_AUTH_LIMITER_UNAVAILABLE', 'Authentication admission unavailable'); }
      if (decision?.allowed === false) return failure(429, 'PRE_AUTH_RATE_LIMITED', 'Authentication rate limit exceeded');
      if (decision?.allowed !== true) return failure(503, 'PRE_AUTH_LIMITER_UNAVAILABLE', 'Authentication admission unavailable');
    }
    let authorization;
    try { authorization = await this.authorize({ method, path: route, request }); }
    catch { return failure(403, 'AUTHORIZATION_ERROR', 'Authorization failed'); }
    if (authorization === false || authorization == null || authorization?.allowed === false) return failure(403, 'FORBIDDEN', 'Control-plane access denied');
    if (authorization !== true && (typeof authorization !== 'object' || authorization.allowed !== true ||
      typeof authorization.principal !== 'string' || !authorization.principal.trim() || authorization.principal.length > 256)) {
      return failure(403, 'AUTHORIZATION_ERROR', 'Authorization must return true or an allowed principal');
    }
    if (authorization === true && this.requireAuthenticatedIdentity) return failure(403, 'AUTHENTICATED_IDENTITY_REQUIRED', 'A verified principal is required');
    // Only the authorization callback may establish a trusted client key.
    // A raw request field or client-supplied header cannot select a principal.
    const trustedRequest = { ...request,
      headers: Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => !/^(authorization|proxy-authorization)$/i.test(name))),
      clientKey: authorization === true ? undefined : `auth:${authorization.principal.trim()}` };

    let admission;
    if (this.requestGuard) {
      try { admission = await this.requestGuard.admit(trustedRequest); }
      catch { return failure(503, 'REQUEST_GUARD_UNAVAILABLE', 'Request guard unavailable'); }
      if (admission.decision === 'replay') return admission.response;
      if (admission.decision === 'in_progress') return failure(409, 'IDEMPOTENCY_IN_PROGRESS', 'Request is in progress');
      if (admission.decision === 'recovery_required') return failure(409, 'IDEMPOTENCY_RECOVERY_REQUIRED', 'Request outcome requires reconciliation');
      if (admission.decision === 'denied') {
        const code = admission.error.code;
        return failure(code === 'RATE_LIMITED' ? 429 : code.endsWith('_UNAVAILABLE') ? 503 : code === 'BODY_TOO_LARGE' ? 413 : code === 'IDEMPOTENCY_CONFLICT' || code === 'IDEMPOTENCY_CAPACITY' ? 409 : 400, code, admission.error.message);
      }
    }
    const result = await this.#dispatch(trustedRequest, method, route, parsed);
    if (admission?.cacheKey) {
      try {
        if (!await this.requestGuard.complete(admission, result)) return failure(503, 'IDEMPOTENCY_COMPLETION_FAILED', 'Could not commit idempotency response');
      } catch { return failure(503, 'IDEMPOTENCY_COMPLETION_FAILED', 'Could not commit idempotency response'); }
    }
    return result;
  }

  async #dispatch(request, method, route, parsed) {
    try {
      if (method === 'GET' && route === '/health') return ok(await this.controlPlane.getHealth());
      if (method === 'GET' && route === '/metrics') return ok(this.controlPlane.observability.getMetrics());
      if (method === 'GET' && route === '/traces') return ok(this.controlPlane.observability.getTraces(queryFilter(parsed.searchParams)));
      if (method === 'GET' && route === '/events') return ok(this.controlPlane.observability.getEvents(queryFilter(parsed.searchParams)));
      if (method === 'GET' && route === '/executions') return ok(this.controlPlane.getExecutions(executionFilter(parsed.searchParams)));
      if (method === 'GET' && route === '/evolution') return ok(await this.controlPlane.getEvolution());
      if (method === 'GET' && route === '/snapshot') return ok(await this.controlPlane.snapshot());
      if (method === 'GET' && route === '/operations') return ok(this.operations.getOperations());
      if (method === 'GET' && route === '/diagnostics') return ok(await this.operations.diagnostics());
      if (method === 'GET' && route === '/commands') return ok(this.commands.list());
      if (method === 'POST' && route === '/commands') {
        const body = request.body === undefined ? {} : request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'INVALID_BODY', 'Command body must be an object');
        if (typeof body.command !== 'string' || !body.command.trim()) return failure(400, 'INVALID_INPUT', 'command must be a non-empty string');
        const result = await this.commands.execute(body.command, body.input ?? {}, { correlationId: body.correlationId, request });
        return result.ok ? ok(result, 200) : commandFailure(result);
      }
      if (method === 'POST' && /^\/executions\/[^/]+\/cancel$/.test(route)) {
        const executionId = decodeURIComponent(route.split('/')[2]);
        const body = request.body === undefined ? {} : request.body;
        if (body !== null && typeof body !== 'object') return failure(400, 'INVALID_BODY', 'Request body must be an object');
        const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason : undefined;
        return ok(await this.controlPlane.cancelExecution(executionId, reason), 202);
      }
      return failure(404, 'NOT_FOUND', `Unknown control-plane route: ${method} ${route}`);
    } catch (error) { return failure(500, 'CONTROL_PLANE_ERROR', error instanceof Error ? error.message : String(error)); }
  }

  async listen({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.server) throw new Error('ControlPlaneGateway is already listening');
    if (host !== '127.0.0.1' && host !== '::1' && !this.explicitAuthorization) throw new TypeError('non-loopback gateway requires authorize()');
    this.requireAuthenticatedIdentity = host !== '127.0.0.1' && host !== '::1';
    this.server = createServer(async (req, res) => {
      let lease;
      if (this.shutdownAdmission) {
        try {
          lease = this.shutdownAdmission.admit(`http:${randomUUID()}`);
          let released = false;
          const release = () => { if (!released) { released = true; this.shutdownAdmission.release(lease); } };
          res.once('finish', release);
          res.once('close', release);
        } catch {
          const denied = failure(503, 'ADMISSION_CLOSED', 'Runtime is draining');
          res.writeHead(denied.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(denied.body));
          return;
        }
      }
      try {
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = await this.handle({ method: req.method, path: req.url, headers: req.headers, body, remoteAddress: req.socket.remoteAddress });
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result.body));
      } catch (error) {
        const result = failure(error.statusCode ?? 400, error.code ?? 'BAD_REQUEST', error.message ?? 'Invalid request');
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result.body));
      }
    });
    return new Promise((resolve, reject) => {
      const onError = (error) => { this.server?.off('listening', onListening); this.server = null; reject(error); };
      const onListening = () => { this.server?.off('error', onError); resolve(this.server.address()); };
      this.server.once('error', onError); this.server.once('listening', onListening); this.server.listen(port, host);
    });
  }

  close() {
    if (!this.server) return Promise.resolve();
    const server = this.server; this.server = null;
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function queryFilter(params) { const filter = {}; for (const key of ['executionId', 'type', 'status']) if (params.has(key)) filter[key] = params.get(key); return filter; }
function executionFilter(params) { const filter = queryFilter(params); if (params.has('limit')) filter.limit = Number(params.get('limit')); return filter; }
function ok(data, status = 200) { return { status, body: { schemaVersion: SCHEMA_VERSION, ok: true, data } }; }
function failure(status, code, message) { return { status, body: { schemaVersion: SCHEMA_VERSION, ok: false, error: { code, message } } }; }
function commandFailure(result) { return { status: result.error.code === 'COMMAND_NOT_FOUND' ? 404 : result.error.code === 'FORBIDDEN' ? 403 : result.error.code === 'INVALID_INPUT' ? 400 : 500, body: { schemaVersion: SCHEMA_VERSION, ok: false, error: result.error, correlationId: result.correlationId } }; }

async function readJsonBody(req, maxBytes) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return undefined;
  let size = 0; let text = '';
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > maxBytes) { const error = new Error(`Request body exceeds ${maxBytes} bytes`); error.statusCode = 413; error.code = 'BODY_TOO_LARGE'; throw error; } text += chunk; }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { const error = new Error('Request body must contain valid JSON'); error.statusCode = 400; error.code = 'INVALID_JSON'; throw error; }
}
