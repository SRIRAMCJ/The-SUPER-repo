import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeAtomicJson } from './atomic-json.js';

const file = process.argv[2];
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw fault('FAILOVER_INPUT_TOO_LARGE');
  }
  const request = JSON.parse(input);
  let parsed;
  let missing = false;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { missing = true; parsed = []; } else throw error; }
  let initialized = false;
  try {
    const marker = JSON.parse(await readFile(`${file}.initialized`, 'utf8'));
    if (marker?.schemaVersion !== '0.1.0' || marker?.initialized !== true) throw fault('FAILOVER_STORE_CORRUPT');
    initialized = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (missing && (initialized || request.observed)) throw fault('FAILOVER_STORE_MISSING');
  if (!Array.isArray(parsed) || parsed.length > 10_000) throw fault('FAILOVER_STORE_CORRUPT');
  const records = new Map();
  for (const record of parsed) {
    if (!record || record.schemaVersion !== '0.1.0' || typeof record.name !== 'string' || !record.name.trim() ||
        typeof record.owner !== 'string' || !record.owner.trim() ||
        (record.token !== null && (typeof record.token !== 'string' || !record.token)) ||
        !Number.isSafeInteger(record.epoch) || record.epoch < 1 ||
        !Number.isSafeInteger(record.version) || record.version < 0 ||
        (record.identity !== undefined && record.identity !== null && (typeof record.identity !== 'string' || !/^[a-f0-9]{64}$/.test(record.identity))) ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0 || records.has(record.name)) throw fault('FAILOVER_STORE_CORRUPT');
    records.set(record.name, record);
  }
  if (!missing && !initialized) {
    // Existing stores from before the marker upgrade acquire one on first access.
    await writeAtomicJson(`${file}.initialized`, { schemaVersion: '0.1.0', initialized: true });
    initialized = true;
  }
  const { action, name, owner, token, epoch, leaseMs, result, identity = null } = request;
  if (typeof name !== 'string' || !name.trim()) throw fault('FAILOVER_NAME_INVALID');
  const now = Date.now();
  const current = records.get(name) ?? null;
  let next = current;
  if (action === 'claim') {
    if (typeof owner !== 'string' || !owner.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !Number.isSafeInteger(now + leaseMs) || current?.epoch === Number.MAX_SAFE_INTEGER) throw fault('FAILOVER_REQUEST_INVALID');
    if (identity !== null && (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity))) throw fault('FAILOVER_REQUEST_INVALID');
    if (current && (current.identity ?? null) !== identity) throw fault('FAILOVER_IDENTITY_CONFLICT');
    if (current?.expiresAt > now) throw fault('FAILOVER_LEASE_HELD');
    next = { schemaVersion: '0.1.0', name, owner, token: randomUUID(), epoch: (current?.epoch ?? 0) + 1, expiresAt: now + leaseMs, version: current?.version ?? 0, result: current?.result ?? null, identity: current?.identity ?? identity };
  } else if (action === 'renew' || action === 'commit' || action === 'release' || action === 'writeEffect') {
    if (!current || !token || current.token !== token || current.epoch !== epoch || current.expiresAt <= now) throw fault('FAILOVER_FENCE_REJECTED');
    if (action === 'renew') {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !Number.isSafeInteger(now + leaseMs)) throw fault('FAILOVER_REQUEST_INVALID');
      next = { ...current, expiresAt: now + leaseMs };
    } else if (action === 'commit') {
      if (result === undefined || current.version === Number.MAX_SAFE_INTEGER) throw fault('FAILOVER_REQUEST_INVALID');
      next = { ...current, result, version: current.version + 1 };
    } else if (action === 'writeEffect') {
      const destination = request.destination;
      if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination === file || destination === `${file}.lock` || request.value === undefined) throw fault('FAILOVER_REQUEST_INVALID');
      await writeAtomicJson(destination, request.value, { beforeRename: () => {
        if (Date.now() >= current.expiresAt) throw fault('FAILOVER_FENCE_REJECTED');
      } });
    } else next = { ...current, token: null, expiresAt: 0 };
  } else if (action !== 'inspect') throw fault('FAILOVER_REQUEST_INVALID');
  if (next !== current) {
    if (!initialized) await writeAtomicJson(`${file}.initialized`, { schemaVersion: '0.1.0', initialized: true });
    records.set(name, next); await writeAtomicJson(file, [...records.values()]);
  }
  process.stdout.write(JSON.stringify({ ok: true, record: next, observed: parsed.length > 0 || next !== null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: typeof error?.code === 'string' && error.code.startsWith('FAILOVER_') ? error.code : 'FAILOVER_STORE_ERROR' }));
}
function fault(code) { return Object.assign(new Error(code), { code }); }
