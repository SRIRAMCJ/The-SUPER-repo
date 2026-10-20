import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MIN_HEAP = 16 * 1024 * 1024;
const MIN_RSS = 64 * 1024 * 1024;

// Trusted modules run in a child process. A supervising thread in that process
// samples worker CPU and JS heap; the parent enforces wall time independently.
export class MeasuredProcessRuntime {
  #active = 0;
  #history = [];

  constructor({ root, maxConcurrent = 2, sampleMs = 10, historyLimit = 128 } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('root is required');
    this.root = realpathSync(root);
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isSafeInteger(sampleMs) || sampleMs < 1 || !Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new TypeError('limits must be positive integers');
    this.maxConcurrent = maxConcurrent;
    this.sampleMs = sampleMs;
    this.historyLimit = historyLimit;
  }

  activeCount() { return this.#active; }
  history() { return Object.freeze([...this.#history]); }

  async execute({ modulePath, exportName = 'run', input = {}, cpuMs, heapBytes, rssBytes, wallMs, signal } = {}) {
    if (typeof modulePath !== 'string' || !modulePath || typeof exportName !== 'string' || !/^[a-zA-Z_$][\w$]*$/.test(exportName)) throw new TypeError('modulePath and exportName are required');
    if (!Number.isSafeInteger(cpuMs) || cpuMs < 1 || !Number.isSafeInteger(heapBytes) || heapBytes < MIN_HEAP || !Number.isSafeInteger(wallMs) || wallMs < 1) throw new TypeError('cpuMs, heapBytes (at least 16 MiB), and wallMs must be positive limits');
    if (rssBytes !== undefined && (!Number.isSafeInteger(rssBytes) || rssBytes < MIN_RSS || process.platform !== 'linux')) throw new TypeError('rssBytes requires Linux and a limit of at least 64 MiB');
    if (signal?.aborted) throw limit('PROCESS_CANCELLED');
    const file = await realpath(path.resolve(this.root, modulePath));
    if (!file.startsWith(`${this.root}${path.sep}`) || !['.js', '.mjs'].includes(path.extname(file)) || !(await stat(file)).isFile()) throw new TypeError('modulePath must be a JavaScript file inside root');
    if (this.#active >= this.maxConcurrent) throw limit('PROCESS_CONCURRENCY_LIMIT');
    this.#active++;
    try {
      const result = await this.#run(file, exportName, input, { cpuMs, heapBytes, rssBytes, wallMs }, signal);
      this.#record({ status: 'succeeded', ...result.usage });
      return result;
    } catch (error) {
      this.#record({ status: 'failed', code: error.code ?? 'PROCESS_FAILED' });
      throw error;
    } finally { this.#active--; }
  }

  #record(entry) { this.#history.push(Object.freeze(entry)); if (this.#history.length > this.historyLimit) this.#history.shift(); }

  #run(file, exportName, input, limits, signal) {
    const child = fork(new URL('./process-budget-child.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    return new Promise((resolve, reject) => {
      let done = false;
      const stop = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(wallTimer);
        signal?.removeEventListener('abort', onAbort);
        child.removeAllListeners('message'); child.removeAllListeners('error'); child.removeAllListeners('exit');
        child.kill('SIGKILL');
        error ? reject(error) : resolve(value);
      };
      child.on('message', (message) => {
        if (message?.ready) {
          child.send({ file, exportName, input, limits, sampleMs: this.sampleMs }, (error) => { if (error) stop(limit('PROCESS_INPUT_INVALID')); });
          return;
        }
        if (message?.ok) {
          if (limits.rssBytes) {
            if (!Number.isSafeInteger(message.usage?.rssBytes) || message.usage.rssBytes < 1) stop(limit('PROCESS_MEASUREMENT_FAILED'));
            else if (message.usage.rssBytes > limits.rssBytes) stop(limit('PROCESS_RSS_LIMIT'));
            else stop(null, { output: message.output, usage: message.usage });
          } else stop(null, { output: message.output, usage: message.usage });
        }
        else stop(limit(message?.code ?? 'PROCESS_FAILED'));
      });
      child.on('error', () => stop(limit('PROCESS_FAILED')));
      child.on('exit', () => stop(limit('PROCESS_EXITED')));
      const wallTimer = setTimeout(() => stop(limit('PROCESS_WALL_LIMIT')), limits.wallMs);
      const onAbort = () => stop(limit('PROCESS_CANCELLED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

function limit(code) { return Object.assign(new Error(code), { code, retryable: false }); }

export function createMeasuredProcessHandler(runtime, { modulePath, exportName = 'run', cpuMs, heapBytes, rssBytes, wallMs } = {}) {
  if (!runtime || typeof runtime.execute !== 'function') throw new TypeError('runtime must expose execute()');
  return async (input, { signal } = {}) => (await runtime.execute({ modulePath, exportName, input, cpuMs, heapBytes, rssBytes, wallMs, signal })).output;
}
