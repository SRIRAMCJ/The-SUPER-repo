#!/usr/bin/env node

import path from 'node:path';
import { createRepositoryAnalystRuntime } from '../../../packages/agents/repository-analyst/src/index.js';
import { createStaticInvestigationRuntime } from '../../../packages/tools/reverse-engineering/src/runtime.js';

const args = process.argv.slice(2);

async function main() {
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'investigate') {
    const target = args[1];
    if (!target || target.startsWith('--')) throw new Error('Usage: super investigate <path> [--query=text] [--json]');
    const unknown = args.slice(2).filter((arg) => arg !== '--json' && !arg.startsWith('--query='));
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    const query = args.find((arg) => arg.startsWith('--query='))?.slice('--query='.length);
    const runtime = createStaticInvestigationRuntime();
    const result = await runtime.execution.execute(runtime.manifest.id, { targetPath: path.resolve(target), options: { query } });
    if (result.status !== 'succeeded') throw new Error(`${result.error.code}: ${result.error.message}`);
    const report = result.output;
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      console.log(`Investigated ${report.files.length} files; ${report.findings.length} evidence items; ${report.skipped.length} skipped`);
      for (const finding of report.findings) console.log(`${finding.evidence.path}:${finding.evidence.line}:${finding.evidence.column} [${finding.kind}] ${finding.value}`);
      for (const limit of report.limitations) console.log(`Limit: ${limit}`);
    }
    return;
  }
  if (command !== 'analyze') throw new Error(`Unknown command: ${command}`);

  const repositoryPath = args.find((arg, index) => index > 0 && !arg.startsWith('--')) ?? process.cwd();
  const json = args.includes('--json');
  const maxFilesArg = args.find((arg) => arg.startsWith('--max-files='));
  const maxFiles = maxFilesArg ? Number(maxFilesArg.slice('--max-files='.length)) : undefined;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) throw new Error('--max-files must be a positive integer');

  const runtime = createRepositoryAnalystRuntime();
  const result = await runtime.agent.executeRequest('analyze this repository for engineering quality', {
    repositoryPath: path.resolve(repositoryPath),
    options: maxFiles ? { maxFiles } : undefined
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHumanReport(result);
  }
  if (result.status !== 'succeeded') process.exitCode = 1;
}

function printHumanReport(result) {
  if (result.status !== 'succeeded') {
    console.error(`Agent failed: ${result.error?.code ?? 'AGENT_ERROR'} — ${result.error?.message ?? 'Unknown error'}`);
    return;
  }
  const report = result.output;
  const severity = report.summary.bySeverity;
  console.log(`Agent: ${result.agentId}`);
  console.log(`Repository: ${report.repository.name}`);
  console.log(`Path: ${report.repository.path}`);
  console.log(`Files: ${report.inventory.files} | Directories: ${report.inventory.directories} | Bytes: ${report.inventory.bytes}`);
  console.log(`Git: ${report.git.available ? `${report.git.branch ?? '(detached)'} @ ${report.git.head}` : 'unavailable'}`);
  console.log(`Findings: ${report.summary.findingCount} (high=${severity.high ?? 0}, medium=${severity.medium ?? 0}, low=${severity.low ?? 0}, info=${severity.info ?? 0})`);
  for (const finding of report.findings) console.log(`- [${finding.severity}] ${finding.title}: ${formatEvidence(finding.evidence)}`);
}

function formatEvidence(evidence) {
  return Array.isArray(evidence) ? evidence.join(', ') : String(evidence ?? '');
}

function printHelp() {
  console.log('SUPER CLI');
  console.log('');
  console.log('Usage:');
  console.log('  super analyze [path] [--json] [--max-files=N]');
  console.log('  super investigate <path> [--query=text] [--json]');
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
