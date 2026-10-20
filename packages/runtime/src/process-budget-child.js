import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

process.on('message', ({ file, exportName, input, limits, sampleMs }) => {
  const worker = new Worker(new URL('./process-budget-thread.js', import.meta.url), {
    workerData: { file, exportName, input },
    resourceLimits: { maxOldGenerationSizeMb: Math.ceil(limits.heapBytes / (1024 * 1024)) },
    execArgv: []
  });
  let done = false, sampling = false, timer;
  const finish = (message) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (message.ok && limits.rssBytes) {
      try {
        const peak = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'));
        if (!peak || !Number.isSafeInteger(Number(peak[1]) * 1024)) throw new Error('RSS unavailable');
        message.usage.rssBytes = Number(peak[1]) * 1024;
      } catch { message = { ok: false, code: 'PROCESS_MEASUREMENT_FAILED' }; }
    }
    process.send(message, () => { void worker.terminate().finally(() => process.exit(0)); });
  };
  const sample = async () => {
    if (done || sampling) return null;
    sampling = true;
    try {
      const [cpu, heap] = await Promise.all([worker.cpuUsage(), worker.getHeapStatistics()]);
      const usage = { cpuMs: (cpu.user + cpu.system) / 1000, heapBytes: heap.used_heap_size };
      if (limits.rssBytes) {
        const peak = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'));
        if (!peak || !Number.isSafeInteger(Number(peak[1]) * 1024)) throw new Error('RSS unavailable');
        usage.rssBytes = Number(peak[1]) * 1024;
        if (usage.rssBytes > limits.rssBytes) { finish({ ok: false, code: 'PROCESS_RSS_LIMIT' }); return null; }
      }
      if (usage.cpuMs > limits.cpuMs) { finish({ ok: false, code: 'PROCESS_CPU_LIMIT' }); return null; }
      if (usage.heapBytes > limits.heapBytes) { finish({ ok: false, code: 'PROCESS_HEAP_LIMIT' }); return null; }
      return usage;
    } catch { finish({ ok: false, code: 'PROCESS_MEASUREMENT_FAILED' }); return null; }
    finally { sampling = false; }
  };
  const poll = async () => { await sample(); if (!done) timer = setTimeout(poll, sampleMs); };
  worker.on('message', async (result) => {
    if (done) return;
    while (sampling && !done) await new Promise((ready) => setImmediate(ready));
    if (done) return;
    const usage = await sample();
    if (done || !usage) return;
    finish(result.ok ? { ok: true, output: result.output, usage } : { ok: false, code: result.code });
  });
  worker.on('error', () => finish({ ok: false, code: 'PROCESS_WORKER_FAILED' }));
  worker.on('exit', () => finish({ ok: false, code: 'PROCESS_WORKER_EXITED' }));
  worker.once('online', () => { if (!done) timer = setTimeout(poll, sampleMs); });
});

process.send({ ready: true });
