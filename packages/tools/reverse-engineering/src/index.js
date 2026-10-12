import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html']);
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const SIGNALS = [
  ['module-import', /\b(?:import\s+(?:[^'";]*?\s+from\s+)?|require\s*\()\s*['"]([^'"\n]+)['"]/g],
  ['module-export', /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let)\s+([\w$]+)/g],
  ['route', /\b(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"\n]+)['"]/g],
  ['electron-ipc', /\b(?:ipcMain|ipcRenderer)\.(?:handle|on|send|invoke)\s*\(\s*['"]([^'"\n]+)['"]/g],
  ['electron-bridge', /\bcontextBridge\.exposeInMainWorld\s*\(\s*['"]([^'"\n]+)['"]/g]
];

export const reverseEngineeringTool = Object.freeze({
  schemaVersion: '0.1.0', id: 'tool/static-javascript-investigation', kind: 'tool',
  name: 'Static JavaScript Investigation', version: '0.1.0', status: 'alpha',
  description: 'Read-only, bounded evidence collection for JavaScript and Electron application files.',
  provenance: { sourceType: 'native' }, operation: 'read', risk: 'low',
  permissions: ['filesystem.read'], sideEffects: [], idempotent: true,
  input: { contentType: 'application/json' }, output: { contentType: 'application/json' }
});

/** Collect structural evidence without loading or running target code. */
export async function investigateJavaScript(targetPath, { query, maxFiles = 500, maxBytes = 512 * 1024 } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) throw new TypeError('targetPath is required');
  if (query !== undefined && (typeof query !== 'string' || query.length > 200)) throw new TypeError('query must be a string of at most 200 characters');
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 5000) throw new RangeError('maxFiles must be between 1 and 5000');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) throw new RangeError('maxBytes must be between 1 and 2097152');
  const root = path.resolve(targetPath);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error('Target must be a regular file or directory');
  const files = [];
  const skipped = [];
  const evidence = [];
  const findings = [];
  async function visit(absolute, relative) {
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { skipped.push({ path: relative || '.', reason: 'file-limit' }); break; }
      if (IGNORED.has(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child, name);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) await inspect(child, name);
      else if (entry.isSymbolicLink()) skipped.push({ path: name, reason: 'symlink' });
    }
  }
  async function inspect(absolute, relative) {
    if (files.length >= maxFiles) { skipped.push({ path: relative, reason: 'file-limit' }); return; }
    const file = await fs.open(absolute, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) { skipped.push({ path: relative, reason: 'size-limit' }); return; }
      const bytes = await file.readFile();
      if (bytes.includes(0)) { skipped.push({ path: relative, reason: 'binary' }); return; }
      const digest = createHash('sha256').update(bytes).digest('hex');
      files.push({ path: relative, bytes: bytes.length, sha256: digest });
      const lines = bytes.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [kind, pattern] of SIGNALS) {
          pattern.lastIndex = 0;
          for (const match of line.matchAll(pattern)) {
            const item = { kind, value: match[1], evidence: { path: relative, line: i + 1, column: match.index + 1, sha256: digest } };
            evidence.push(item);
            if (!query || line.toLowerCase().includes(query.toLowerCase()) || match[1].toLowerCase().includes(query.toLowerCase())) findings.push(item);
          }
        }
        if (query && line.toLowerCase().includes(query.toLowerCase()) && !evidence.some((item) => item.evidence.path === relative && item.evidence.line === i + 1)) {
          findings.push({ kind: 'text-match', value: query, evidence: { path: relative, line: i + 1, column: line.toLowerCase().indexOf(query.toLowerCase()) + 1, sha256: digest } });
        }
      }
    } finally { await file.close(); }
  }
  if (stat.isDirectory()) await visit(root, '');
  else if (EXTENSIONS.has(path.extname(root).toLowerCase())) await inspect(root, path.basename(root));
  else throw new Error('Unsupported target file type');
  return { schemaVersion: '0.1.0', type: 'static-javascript-investigation', target: root, query: query ?? null, files, findings, skipped,
    limitations: ['Static pattern evidence only; behavior and data flow are not verified.', 'Target files were not executed.', 'No native binary, website, or runtime inspection.'] };
}
