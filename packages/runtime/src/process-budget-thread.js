import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

parentPort.on('message', () => {});
try {
  const module = await import(pathToFileURL(workerData.file).href);
  const handler = module[workerData.exportName];
  if (typeof handler !== 'function') throw new TypeError('Module export is not a function');
  parentPort.postMessage({ ok: true, output: await handler(workerData.input) });
} catch { parentPort.postMessage({ ok: false, code: 'PROCESS_HANDLER_FAILED' }); }
