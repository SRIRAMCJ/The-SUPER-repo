import { createServer } from 'node:http';
import { URL } from 'node:url';
import { RuntimeOperations } from './operations.js';
import { RuntimeCommandBus } from './command-bus.js';

const SCHEMA_VERSION = '0.1.0';

export class ControlPlaneGateway {
  constructor({ controlPlane, operations = null, commands = null, authorize = () => true, maxBodyBytes = 65536 } = {}) {
    if (!controlPlane || typeof controlPlane.getHealth !== 'function' || typeof controlPlane.snapshot !== 'function') throw new TypeError('ControlPlaneGateway requires a compatible runtime control plane');
    if (operations && typeof operations.getOperations !== 'function') throw new TypeError('operations must expose getOperations()');
    if (commands && (typeof commands.list !== 'function' || typeof commands.execute !== 'function')) throw new TypeError('commands must expose list() and execute()');
    if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new TypeError('maxBodyBytes must be an integer >= 1024');
    this.controlPlane = controlPlane;
    this.operations = operations ?? new RuntimeOperations({ controlPlane });
    this.commands = commands ?? new RuntimeCommandBus({ controlPlane, operations: this.operations });
    this.authorize = authorize; this.maxBodyBytes = maxBodyBytes; this.server = null;
  }
  async handle(request) {
    if (!request || typeof request !== 'object') return failure(400, 'INVALID_REQUEST', 'Request must be an object');
    const method = String(request.method ?? 'GET').toUpperCase();
    const parsed = new URL(String(request.path ?? '/'), 'http://super.local');
    const route = parsed.pathname.replace(/\/+$/, '') || '/';
    let authorized = false;
    try { authorized = await this.authorize({ method, path: route, request }); } catch (error) { return failure(403, 'AUTHORIZATION_ERROR', error instanceof Error ? error.message : String(error)); }
    if (!authorized) return failure(403, 'FORBIDDEN', 'Control-plane access denied');
    try {
      if (method === 'GET' && route === '/health') return ok(await this.controlPlane.getHealth());
      if (method === 'GET' && route === '/metrics') return ok(this.controlPlane.observability.getMetrics());
      if (method === 'GET' && route === '/traces') return ok(this.controlPlane.observability.getTraces(queryFilter(parsed.searchParams)));
      if (method === 'GET' && route === '/events') return ok(this.controlPlane.observability.getEvents(queryFilter(parsed.searchParams)));
      if (method === 'GET' && route === '/executions') return ok(this.controlPlane.getExecutions(executionFilter(parsed.searchParams)));
      if (method === 'GET' && route === '/evolution') return ok(await this.controlPlane.getEvolution());
      if (method === 'GET' && route === '/recovery') return ok(await this.controlPlane.getRecovery());
      if (method === 'GET' && route === '/supervisor') return ok(await this.controlPlane.getSupervisorHealth({ correlationId: parsed.searchParams.get('correlationId') }));
      if (method === 'GET' && route === '/snapshot') return ok(await this.controlPlane.snapshot());
      if (method === 'GET' && route === '/operations') return ok(this.operations.getOperations());
      if (method === 'GET' && route === '/diagnostics') return ok(await this.operations.diagnostics());
      if (method === 'GET' && route === '/commands') return ok(this.commands.list());
      if (method === 'POST' && route === '/recovery') {
        const body = request.body === undefined ? {} : request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'INVALID_BODY', 'Recovery body must be an object');
        const result = await this.commands.execute('runtime.recover', body, { correlationId: body.correlationId, request, signal: request.signal });
        return result.ok ? ok(result, 202) : commandFailure(result);
      }
      if (method === 'POST' && route === '/commands') {
        const body = request.body === undefined ? {} : request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'INVALID_BODY', 'Command body must be an object');
        if (typeof body.command !== 'string' || !body.command.trim()) return failure(400, 'INVALID_INPUT', 'command must be a non-empty string');
        const result = await this.commands.execute(body.command, body.input ?? {}, { correlationId: body.correlationId, request, signal: request.signal });
        return result.ok ? ok(result, 200) : commandFailure(result);
      }
      if (method === 'POST' && /^\/executions\/[^/]+\/cancel$/.test(route)) {
        const executionId = decodeURIComponent(route.split('/')[2]); const body = request.body === undefined ? {} : request.body;
        if (body !== null && typeof body !== 'object') return failure(400, 'INVALID_BODY', 'Request body must be an object');
        return ok(await this.controlPlane.cancelExecution(executionId, typeof body?.reason === 'string' && body.reason.trim() ? body.reason : undefined), 202);
      }
      return failure(404, 'NOT_FOUND', `Unknown control-plane route: ${method} ${route}`);
    } catch (error) { return failure(500, 'CONTROL_PLANE_ERROR', error instanceof Error ? error.message : String(error)); }
  }
  listen({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.server) throw new Error('ControlPlaneGateway is already listening');
    this.server = createServer(async (req, res) => { try { const body = await readJsonBody(req, this.maxBodyBytes); const result = await this.handle({ method: req.method, path: req.url, headers: req.headers, body, signal: req.signal }); res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(result.body)); } catch (error) { const result = failure(error.statusCode ?? 400, error.code ?? 'BAD_REQUEST', error.message ?? 'Invalid request'); res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(result.body)); } });
    return new Promise((resolve, reject) => { const onError = (error) => { this.server?.off('listening', onListening); this.server = null; reject(error); }; const onListening = () => { this.server?.off('error', onError); resolve(this.server.address()); }; this.server.once('error', onError); this.server.once('listening', onListening); this.server.listen(port, host); });
  }
  close() { if (!this.server) return Promise.resolve(); const server = this.server; this.server = null; return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
function queryFilter(params) { const filter = {}; for (const key of ['executionId', 'type', 'status']) if (params.has(key)) filter[key] = params.get(key); return filter; }
function executionFilter(params) { const filter = queryFilter(params); if (params.has('limit')) filter.limit = Number(params.get('limit')); return filter; }
function ok(data, status = 200) { return { status, body: { schemaVersion: SCHEMA_VERSION, ok: true, data } }; }
function failure(status, code, message) { return { status, body: { schemaVersion: SCHEMA_VERSION, ok: false, error: { code, message } } }; }
function commandFailure(result) { return { status: result.error.code === 'COMMAND_NOT_FOUND' ? 404 : result.error.code === 'FORBIDDEN' ? 403 : result.error.code === 'INVALID_INPUT' ? 400 : 500, body: { schemaVersion: SCHEMA_VERSION, ok: false, error: result.error, correlationId: result.correlationId } }; }
async function readJsonBody(req, maxBytes) { if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return undefined; let size = 0; let text = ''; for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > maxBytes) { const error = new Error(`Request body exceeds ${maxBytes} bytes`); error.statusCode = 413; error.code = 'BODY_TOO_LARGE'; throw error; } text += chunk; } if (!text.trim()) return {}; try { return JSON.parse(text); } catch { const error = new Error('Request body must contain valid JSON'); error.statusCode = 400; error.code = 'INVALID_JSON'; throw error; } }
