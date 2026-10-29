#!/usr/bin/env node

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRepositoryAnalystRuntime } from '../../../packages/agents/repository-analyst/src/index.js';
import { createStaticInvestigationRuntime } from '../../../packages/tools/reverse-engineering/src/runtime.js';

const args = process.argv.slice(2);

async function main() {
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'references') {
    const unknown = args.slice(1).filter((arg) => arg !== '--json' && !arg.startsWith('--phase='));
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    const rawPhase = args.find((arg) => arg.startsWith('--phase='));
    const phase = rawPhase ? Number(rawPhase.slice('--phase='.length)) : undefined;
    if (phase !== undefined && (!Number.isInteger(phase) || phase < 1 || phase > 8)) throw new Error('--phase must be an integer from 1 to 8');
    const catalogPath = fileURLToPath(new URL('../../../docs/reference-adoption.json', import.meta.url));
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    const entries = catalog.references.filter((entry) => phase === undefined || entry.phase === phase);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ schemaVersion: catalog.schemaVersion, references: entries }, null, 2)}\n`);
    else for (const entry of entries) console.log(`${entry.phase}\t${entry.name}\t${entry.status}\t${entry.url}`);
    return;
  }
  if (command === 'investigate') {
    const target = args[1];
    if (!target || target.startsWith('--')) throw new Error('Usage: super investigate <path> [--query=text] [--json]');
    const unknown = args.slice(2).filter((arg) => arg !== '--json' && !arg.startsWith('--query=') && !arg.startsWith('--max-files=') && !arg.startsWith('--max-findings='));
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    const query = args.find((arg) => arg.startsWith('--query='))?.slice('--query='.length);
    const maxFiles = parseOptionalLimit('--max-files=');
    const maxFindings = parseOptionalLimit('--max-findings=');
    const runtime = createStaticInvestigationRuntime();
    const result = await runtime.execution.execute(runtime.manifest.id, { targetPath: path.resolve(target), options: { query, maxFiles, maxFindings } });
    if (result.status !== 'succeeded') throw new Error(`${result.error.code}: ${result.error.message}`);
    const report = result.output;
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      console.log(`Investigated ${report.files.length} files; ${report.findings.length} evidence items; ${report.skipped.length} skipped`);
      if (report.limits.fileLimitReached || report.limits.findingsLimitReached) console.log('Inspection limit reached; results may be incomplete');
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

function parseOptionalLimit(prefix) {
  const raw = args.find((arg) => arg.startsWith(prefix));
  if (!raw) return undefined;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${prefix.slice(0, -1)} must be a positive integer`);
  return value;
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
  console.log('  super investigate <path> [--query=text] [--max-files=N] [--max-findings=N] [--json]');
  console.log('  super references [--phase=1..8] [--json]');
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
