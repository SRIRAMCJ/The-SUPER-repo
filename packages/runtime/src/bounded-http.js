// Explicit HTTP boundary for trusted tool handlers. A request is charged
// before dispatch, including failed attempts. Arbitrary handler networking is
// outside this adapter and requires process/OS isolation for hard enforcement.
export class BoundedHttpTransport {
  constructor({ allowedOrigins, fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxResponseBytes = 1_000_000, maxRequestBytes = 1_000_000 } = {}) {
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.some((origin) => !validOrigin(origin)) || new Set(allowedOrigins).size !== allowedOrigins.length) throw new TypeError('allowedOrigins must contain exact HTTP(S) origins');
    if (typeof fetchImpl !== 'function' || ![timeoutMs, maxResponseBytes, maxRequestBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('fetchImpl and positive limits are required');
    this.allowedOrigins = new Set(allowedOrigins);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxRequestBytes = maxRequestBytes;
  }

  session({ maxRequests, signal } = {}) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) throw new TypeError('maxRequests must be a non-negative integer');
    let used = 0;
    return Object.freeze({
      get used() { return used; },
      request: async (url, { method = 'GET', headers, body } = {}) => {
        if (signal?.aborted) throw fault('NETWORK_CANCELLED');
        const target = new URL(url);
        if (!this.allowedOrigins.has(target.origin) || target.username || target.password) throw fault('NETWORK_ORIGIN_DENIED');
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw fault('NETWORK_METHOD_DENIED');
        if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new TypeError('body must be text or bytes');
        if (body?.length > this.maxRequestBytes) throw fault('NETWORK_REQUEST_TOO_LARGE');
        if (used >= maxRequests) throw fault('NETWORK_REQUEST_LIMIT');
        used++;
        const controller = new AbortController();
        const abort = () => controller.abort(fault('NETWORK_CANCELLED'));
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(fault('NETWORK_TIMEOUT')), this.timeoutMs);
        const aborted = new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        try {
          if (signal?.aborted) abort();
          const response = await Promise.race([this.fetchImpl(target, { method, headers, body, redirect: 'manual', signal: controller.signal }), aborted]);
          if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw fault('NETWORK_REDIRECT_DENIED'); }
          const chunks = [];
          let bytes = 0;
          if (response.body) {
            const reader = response.body.getReader();
            try {
              while (true) {
                const { value, done } = await Promise.race([reader.read(), aborted]);
                if (done) break;
                bytes += value.byteLength;
                if (bytes > this.maxResponseBytes) { void reader.cancel().catch(() => {}); throw fault('NETWORK_RESPONSE_TOO_LARGE'); }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
          }
          const output = new Uint8Array(bytes);
          let position = 0;
          for (const chunk of chunks) { output.set(chunk, position); position += chunk.byteLength; }
          return Object.freeze({ status: response.status, body: output });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw error;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      }
    });
  }
}

function validOrigin(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; }
  catch { return false; }
}
function fault(code) { return Object.assign(new Error(code), { code }); }
