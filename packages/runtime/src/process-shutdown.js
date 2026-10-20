const EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

// Opt-in process wiring. Install once after constructing the lifecycle coordinator.
export function installProcessShutdown({ coordinator, processRef = process, deadlineMs = 30_000, onError = defaultError } = {}) {
  if (!coordinator || typeof coordinator.shutdown !== 'function' || !coordinator.admission || typeof coordinator.admission.forceStop !== 'function') throw new TypeError('coordinator must expose shutdown() and its admission gate');
  if (!processRef || typeof processRef.on !== 'function' || typeof processRef.removeListener !== 'function' || typeof processRef.exit !== 'function') throw new TypeError('processRef must expose on(), removeListener(), and exit()');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new TypeError('deadlineMs must be a non-negative integer');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');

  let disposed = false;
  let pending = null;
  let firstSignal = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    processRef.removeListener('SIGINT', onInterrupt);
    processRef.removeListener('SIGTERM', onTerminate);
  };
  const fail = (error) => {
    if (disposed) return;
    dispose();
    coordinator.admission.forceStop();
    try { onError(error, firstSignal); } catch { /* A logger must not mask shutdown failure. */ }
    processRef.exit(EXIT_CODES[firstSignal]);
  };
  const onSignal = (signal) => {
    if (disposed) return;
    if (pending) {
      // A second signal requests immediate process termination; leases remain
      // visible until the process actually exits.
      dispose();
      coordinator.admission.forceStop();
      processRef.exit(EXIT_CODES[signal]);
      return;
    }
    firstSignal = signal;
    try {
      // shutdown() closes admission synchronously before the next event can run.
      pending = Promise.resolve(coordinator.shutdown({ deadlineMs }));
    } catch (error) { fail(error); return; }
    pending.then(() => { dispose(); }, fail);
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  processRef.on('SIGINT', onInterrupt);
  processRef.on('SIGTERM', onTerminate);
  return Object.freeze({ dispose, get pending() { return pending; } });
}

function defaultError(error, signal) { console.error(`SUPER shutdown after ${signal} failed:`, error); }
