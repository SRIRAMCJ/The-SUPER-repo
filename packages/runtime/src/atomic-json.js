import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Atomic replacement for a single writer. This is not a distributed CAS store.
export async function writeAtomicJson(filePath, value, { beforeRename, space = 2 } = {}) {
  if (space !== 0 && space !== 2) throw new TypeError('space must be 0 or 2');
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, space), 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    if (beforeRename) await beforeRename();
    await rename(temporaryPath, filePath);
    const directory = await open(path.dirname(filePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
