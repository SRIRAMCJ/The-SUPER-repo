const SCHEMA_VERSION = '0.1.0';

export class RuntimeOperations {
  constructor({ controlPlane, runtimeVersion = '0.1.0', platform = process.platform, nodeVersion = process.version, clock = () => new Date() } = {}) {
    if (!controlPlane || typeof controlPlane.getHealth !== 'function' || typeof controlPlane.snapshot !== 'function') throw new TypeError('RuntimeOperations requires a compatible control plane');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.controlPlane = controlPlane;
    this.runtimeVersion = runtimeVersion;
    this.platform = platform;
    this.nodeVersion = nodeVersion;
    this.clock = clock;
  }
  getOperations() {
    const operations = [
      operation('runtime.health', 'GET', '/health', 'read', 'Read current runtime health'),
      operation('runtime.metrics', 'GET', '/metrics', 'read', 'Read runtime metrics'),
      operation('runtime.traces', 'GET', '/traces', 'read', 'Read bounded runtime traces'),
      operation('runtime.events', 'GET', '/events', 'read', 'Read bounded metadata-only runtime events'),
      operation('runtime.executions', 'GET', '/executions', 'read', 'Inspect execution lifecycle state'),
      operation('runtime.evolution', 'GET', '/evolution', 'read', 'Inspect evolution-control state'),
      operation('runtime.recovery', 'GET', '/recovery', 'read', 'Inspect runtime recovery state'),
      operation('runtime.supervisor', 'GET', '/supervisor', 'read', 'Inspect aggregated runtime component health'),
      operation('runtime.snapshot', 'GET', '/snapshot', 'read', 'Capture a unified runtime snapshot'),
      operation('runtime.diagnostics', 'GET', '/diagnostics', 'read', 'Run deterministic runtime diagnostics'),
      operation('runtime.cancel', 'POST', '/executions/:executionId/cancel', 'control', 'Request cancellation of an execution'),
      operation('runtime.recover', 'POST', '/recovery', 'control', 'Perform a coordinated runtime recovery')
    ];
    return Object.freeze(operations.map((item) => Object.freeze(item)));
  }
  async diagnostics() {
    const checks = [];
    const add = (id, severity, status, message, details = {}) => checks.push({ id, severity, status, message, details });
    const cp = this.controlPlane;
    try { const health = cp.getHealth(); add('control-plane.health', health.status === 'healthy' ? 'info' : 'error', health.status === 'healthy' ? 'pass' : 'fail', `Runtime health is ${health.status}`, { status: health.status, activeExecutions: health.activeExecutions, recentFailures: health.recentFailures }); } catch (error) { add('control-plane.health', 'error', 'fail', 'Runtime health check failed', { error: errorMessage(error) }); }
    checkComponent(checks, 'observability', cp.observability, ['getMetrics', 'getEvents', 'getTraces']);
    checkComponent(checks, 'state-store', cp.stateStore, ['list'], true);
    checkComponent(checks, 'evolution-control', cp.evolutionControlPlane, ['list'], true);
    checkComponent(checks, 'execution-engine', cp.executionEngine, ['cancel'], true);
    checkComponent(checks, 'recovery-kernel', cp.recoveryKernel, ['recover', 'snapshot'], true);
    checkComponent(checks, 'supervisor', cp.supervisor, ['health', 'snapshot'], true);
    try { const metrics = cp.observability.getMetrics(); const eventCount = cp.observability.getEvents().length; const traceCount = cp.observability.getTraces().length; add('observability.retention', 'info', 'pass', 'Bounded observability data is readable', { retainedEvents: eventCount, retainedTraces: traceCount, activeExecutions: metrics.activeExecutions }); } catch (error) { add('observability.retention', 'error', 'fail', 'Observability retention could not be inspected', { error: errorMessage(error) }); }
    const failures = checks.filter((check) => check.status === 'fail');
    const warnings = checks.filter((check) => check.status === 'warning');
    const status = failures.length ? 'failed' : warnings.length ? 'degraded' : 'passed';
    return Object.freeze(structuredClone({ schemaVersion: SCHEMA_VERSION, type: 'runtime-diagnostics', generatedAt: this.clock().toISOString(), status, summary: { checks: checks.length, passed: checks.filter((check) => check.status === 'pass').length, failed: failures.length, warnings: warnings.length }, runtime: { version: this.runtimeVersion, nodeVersion: this.nodeVersion, platform: this.platform }, operations: { count: this.getOperations().length, controlOperations: this.getOperations().filter((item) => item.classification === 'control').length }, checks }));
  }
}
function operation(id, method, path, classification, description) { return { id, method, path, classification, description, schemaVersion: SCHEMA_VERSION }; }
function checkComponent(checks, id, component, methods, optional = false) { const available = component && methods.every((method) => typeof component[method] === 'function'); checks.push({ id: `component.${id}`, severity: optional ? 'info' : 'error', status: available ? 'pass' : optional ? 'not_configured' : 'fail', message: available ? `${id} is available` : `${id} is ${optional ? 'not configured' : 'unavailable'}`, details: { configured: Boolean(component), requiredMethods: methods } }); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
