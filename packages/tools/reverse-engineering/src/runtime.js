import { CapabilityRegistry, EventBus, ExecutionAudit, ExecutionEngine, PolicyEngine, VerificationEngine } from '../../../runtime/src/index.js';
import { investigateJavaScript, reverseEngineeringTool } from './index.js';

export function createStaticInvestigationRuntime({ policies = [], clock } = {}) {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  const audit = new ExecutionAudit({ events, clock });
  const policy = new PolicyEngine({ policies });
  const verifier = new VerificationEngine({ checks: [verifyInvestigation] });
  registry.register(reverseEngineeringTool, (input) => investigateJavaScript(input?.targetPath, input?.options));
  const execution = new ExecutionEngine({ registry, events, policy, verifier, clock });
  return { registry, events, audit, policy, verifier, execution, manifest: reverseEngineeringTool };
}

export function verifyInvestigation({ capability, output }) {
  if (capability.id !== reverseEngineeringTool.id) return { ok: true };
  if (output?.type !== 'static-javascript-investigation' || output.schemaVersion !== '0.1.0' ||
      !Array.isArray(output.files) || !Array.isArray(output.findings) || !Array.isArray(output.skipped) ||
      !output.limits || !Number.isSafeInteger(output.limits.filesConsidered) ||
      typeof output.limits.fileLimitReached !== 'boolean' || typeof output.limits.findingsLimitReached !== 'boolean') {
    return invalid('Investigation report shape is invalid');
  }
  const files = new Map();
  for (const file of output.files) {
    if (typeof file?.path !== 'string' || !file.path || files.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) return invalid('Invalid file evidence');
    files.set(file.path, file.sha256);
  }
  for (const item of output.findings) {
    const e = item?.evidence;
    if (typeof item?.kind !== 'string' || typeof item.value !== 'string' ||
        !e || files.get(e.path) !== e.sha256 ||
        !Number.isSafeInteger(e.line) || e.line < 1 || !Number.isSafeInteger(e.column) || e.column < 1) {
      return invalid('Finding lacks valid file, location, or digest evidence');
    }
  }
  return { ok: true };
}

function invalid(message) { return { ok: false, code: 'INVESTIGATION_EVIDENCE_INVALID', message }; }
