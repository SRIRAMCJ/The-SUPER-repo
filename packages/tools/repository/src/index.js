export { analyzeRepository } from './analyzer.js';

export const repositoryAnalyzerTool = Object.freeze({
  schemaVersion: '0.1.0',
  id: 'tool/repository-analyzer',
  kind: 'tool',
  name: 'Repository Analyzer',
  version: '0.1.0',
  status: 'alpha',
  description: 'Deterministically inspects a local repository and produces structured engineering findings.',
  provenance: { sourceType: 'native' },
  operation: 'read',
  risk: 'low',
  permissions: ['filesystem.read', 'process.git'],
  sideEffects: [],
  input: { contentType: 'application/json', description: 'Repository path and analysis limits.' },
  output: { contentType: 'application/json', description: 'Structured repository inventory, git metadata, and findings.' },
  idempotent: true,
  metadata: { category: 'repository-analysis' }
});
