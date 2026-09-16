import { CapabilityRegistry, EventBus, ExecutionAudit, ExecutionEngine, MemoryStore, MissionEngine, PolicyEngine, VerificationEngine, WorkflowEngine } from '../../../runtime/src/index.js';
import { analyzeRepository, repositoryAnalyzerTool } from '../../../tools/repository/src/index.js';

export const repositoryAnalystAgent = Object.freeze({
  schemaVersion: '0.1.0',
  id: 'agent/repository-analyst',
  kind: 'agent',
  name: 'Repository Analyst',
  version: '0.1.0',
  status: 'alpha',
  description: 'Analyzes a repository for structure, Git state, test coverage signals, maintenance risks, and security hygiene.',
  provenance: { sourceType: 'native' },
  role: 'Repository analysis and engineering quality assessment',
  capabilities: ['tool/repository-analyzer'],
  tools: ['tool/repository-analyzer'],
  execution: { mode: 'task', autonomy: 'bounded', maxSteps: 1, requiresApproval: false },
  input: { contentType: 'application/json', schema: { repositoryPath: 'string' }, required: true },
  output: { contentType: 'application/json', required: true }
});

export function createRepositoryAnalystRuntime({ clock } = {}) {
  const events = new EventBus();
  const audit = new ExecutionAudit({ events, clock });
  const memory = new MemoryStore();
  const registry = new CapabilityRegistry();
  const policy = new PolicyEngine();
  const verifier = new VerificationEngine({ checks: [verifyRepositoryReport] });
  const execution = new ExecutionEngine({ registry, events, verifier, clock });
  const workflow = new WorkflowEngine({ registry, executionEngine: execution, policy, events, clock });
  const mission = new MissionEngine({ workflowEngine: workflow, events, memory, clock });

  registry.register(repositoryAnalyzerTool, async (input) => analyzeRepository(input.repositoryPath, input.options));
  const workflowManifest = {
    schemaVersion: '0.1.0', id: 'workflow/repository-analysis', kind: 'workflow', name: 'Repository Analysis', version: '0.1.0', status: 'alpha',
    description: 'Runs the repository analyzer and returns its verified report.', provenance: { sourceType: 'native' },
    steps: [{ id: 'analyze', capability: repositoryAnalyzerTool.id }]
  };
  registry.register(workflowManifest);
  const missionManifest = {
    schemaVersion: '0.1.0', id: 'mission/analyze-repository', kind: 'mission', name: 'Analyze Repository', version: '0.1.0', status: 'alpha',
    description: 'Analyze a repository and return a verified engineering report.', provenance: { sourceType: 'native' }, workflow: workflowManifest.id
  };
  registry.register(missionManifest);

  return { events, audit, memory, registry, policy, verifier, execution, workflow, mission, manifests: { agent: repositoryAnalystAgent, workflow: workflowManifest, mission: missionManifest } };
}

function verifyRepositoryReport({ output }) {
  const required = ['schemaVersion', 'type', 'repository', 'inventory', 'packages', 'git', 'findings', 'summary'];
  const missing = required.filter((key) => !(key in (output ?? {})));
  if (missing.length) return { ok: false, code: 'REPORT_SHAPE_INVALID', message: `Missing report fields: ${missing.join(', ')}` };
  if (output.type !== 'repository-analysis') return { ok: false, code: 'REPORT_TYPE_INVALID', message: 'Unexpected repository report type' };
  if (!Array.isArray(output.findings)) return { ok: false, code: 'REPORT_FINDINGS_INVALID', message: 'Report findings must be an array' };
  return { ok: true };
}
