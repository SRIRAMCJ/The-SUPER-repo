import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache']);
const TEXT_EXTENSIONS = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json','.md','.yml','.yaml','.toml','.xml','.html','.css','.scss','.py','.go','.rs','.java','.kt','.swift','.c','.cpp','.h','.hpp','.cs','.sh']);

export async function analyzeRepository(repositoryPath, options = {}) {
  const root = path.resolve(repositoryPath ?? process.cwd());
  const maxFiles = options.maxFiles ?? 5000;
  const maxTextBytes = options.maxTextBytes ?? 256 * 1024;
  const ignores = new Set([...DEFAULT_IGNORES, ...(options.ignore ?? [])]);

  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Repository path is not a directory: ${root}`);

  const inventory = { files: 0, directories: 0, bytes: 0, byExtension: {}, largeFiles: [], envFiles: [], todos: 0 };
  const filePaths = [];
  await walk(root, root, ignores, inventory, filePaths, { maxFiles, maxTextBytes });

  const packageManifests = await readPackageManifests(root, filePaths);
  const git = await inspectGit(root);
  const findings = buildFindings({ root, inventory, filePaths, packageManifests, git });

  return {
    schemaVersion: '0.1.0',
    type: 'repository-analysis',
    repository: { path: root, name: path.basename(root) },
    analyzedAt: new Date().toISOString(),
    inventory: { ...inventory, fileCountLimitReached: filePaths.length >= maxFiles },
    packages: packageManifests,
    git,
    findings,
    summary: {
      findingCount: findings.length,
      bySeverity: findings.reduce((counts, finding) => {
        counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
        return counts;
      }, {})
    }
  };
}

async function walk(root, current, ignores, inventory, filePaths, limits) {
  if (filePaths.length >= limits.maxFiles) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (filePaths.length >= limits.maxFiles) return;
    if (entry.isDirectory() && ignores.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      inventory.directories += 1;
      await walk(root, absolute, ignores, inventory, filePaths, limits);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(absolute);
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
    inventory.files += 1;
    inventory.bytes += stat.size;
    const extension = path.extname(entry.name).toLowerCase() || '[no-extension]';
    inventory.byExtension[extension] = (inventory.byExtension[extension] ?? 0) + 1;
    if (stat.size > 1024 * 1024) inventory.largeFiles.push({ path: relative, bytes: stat.size });
    if (/^\.env(?:\.|$)/i.test(entry.name) && !/^\.env\.example$/i.test(entry.name)) inventory.envFiles.push(relative);
    filePaths.push({ absolute, relative, size: stat.size, extension });
    if (TEXT_EXTENSIONS.has(extension) && stat.size <= limits.maxTextBytes) {
      const text = await fs.readFile(absolute, 'utf8');
      inventory.todos += (text.match(/\b(?:TODO|FIXME|HACK)\b/g) ?? []).length;
    }
  }
}

async function readPackageManifests(root, filePaths) {
  const manifests = [];
  for (const file of filePaths.filter((item) => item.relative === 'package.json' || item.relative.endsWith('/package.json'))) {
    try {
      const parsed = JSON.parse(await fs.readFile(file.absolute, 'utf8'));
      manifests.push({
        path: file.relative,
        name: parsed.name ?? null,
        version: parsed.version ?? null,
        private: parsed.private === true,
        scripts: Object.keys(parsed.scripts ?? {}).sort(),
        dependencies: Object.keys(parsed.dependencies ?? {}).sort(),
        devDependencies: Object.keys(parsed.devDependencies ?? {}).sort(),
        workspaces: parsed.workspaces ?? null
      });
    } catch (error) {
      manifests.push({ path: file.relative, parseError: error instanceof Error ? error.message : String(error) });
    }
  }
  return manifests;
}

async function inspectGit(root) {
  try {
    const run = async (args) => (await execFileAsync('git', args, { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const [branch, status, head, log] = await Promise.all([
      run(['branch', '--show-current']),
      run(['status', '--short']),
      run(['rev-parse', 'HEAD']),
      run(['log', '-5', '--pretty=format:%h%x09%s'])
    ]);
    const tracked = await run(['ls-files']);
    return {
      available: true,
      branch: branch || null,
      head,
      clean: status.length === 0,
      status: status ? status.split('\n') : [],
      recentCommits: log ? log.split('\n').map(parseCommit) : [],
      trackedFiles: tracked ? tracked.split('\n').filter(Boolean).length : 0
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function parseCommit(line) {
  const [hash, ...message] = line.split('\t');
  return { hash, message: message.join('\t') };
}

function buildFindings({ inventory, filePaths, packageManifests, git }) {
  const findings = [];
  const names = new Set(filePaths.map((file) => file.relative.toLowerCase()));
  if (!names.has('readme.md')) findings.push({ id:'repo/missing-readme', severity:'medium', title:'README is missing', evidence:'No README.md found at repository root.' });
  if (!git.available) findings.push({ id:'git/unavailable', severity:'low', title:'Git metadata unavailable', evidence:git.reason });
  if (git.available && !git.clean) findings.push({ id:'git/worktree-dirty', severity:'low', title:'Working tree has uncommitted changes', evidence:git.status.slice(0, 20) });
  if (inventory.envFiles.length) findings.push({ id:'security/env-files', severity:'high', title:'Environment files are present in the repository tree', evidence:inventory.envFiles.slice(0, 20) });
  if (!filePaths.some((file) => ['.gitignore'].includes(file.relative))) findings.push({ id:'repo/missing-gitignore', severity:'medium', title:'.gitignore is missing', evidence:'No .gitignore found at repository root.' });
  if (!packageManifests.length && inventory.files > 0) findings.push({ id:'repo/no-package-manifest', severity:'info', title:'No package manifest detected', evidence:'No package.json files were found.' });
  for (const pkg of packageManifests) {
    if (!pkg.parseError && pkg.name && !pkg.scripts.includes('test')) findings.push({ id:`quality/no-test-script:${pkg.path}`, severity:'medium', title:'Package has no test script', evidence:`${pkg.path} (${pkg.name}) does not declare scripts.test.` });
  }
  if (inventory.todos > 25) findings.push({ id:'maintenance/todo-density', severity:'low', title:'High TODO/FIXME density', evidence:`Found ${inventory.todos} TODO/FIXME/HACK markers.` });
  for (const large of inventory.largeFiles.slice(0, 10)) findings.push({ id:`performance/large-file:${large.path}`, severity:'low', title:'Large repository file', evidence:`${large.path} is ${large.bytes} bytes.` });
  return findings;
}
