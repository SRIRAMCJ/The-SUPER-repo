import { RemoteWorkerAuthenticator, FileRemoteNonceStore, DurableIdempotencyStore, FileEventJournal,
  FileFailoverStore, UnixWorkerServer } from '../src/index.js';
import path from 'node:path';

const directory = process.argv[2];
const server = new UnixWorkerServer({ socketPath: path.join(directory, 'worker.sock'), nodeId: 'node-1',
  authenticator: new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 17) }),
  nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }),
  idempotencyStore: await new DurableIdempotencyStore({ filePath: path.join(directory, 'idempotency.jsonl'), ttlMs: 1000 }).init(),
  auditJournal: new FileEventJournal(path.join(directory, 'audit')),
  authorize: () => ({ allowed: true }),
  effectStore: new FileFailoverStore(path.join(directory, 'leases.json')),
  effects: { persist: path.join(directory, 'effect.json') },
  handlers: { persist: async (input, context) => {
    await context.writeEffect(input);
    process.stdout.write('effect\n');
    await new Promise(() => {});
  } }
});
await server.start();
process.stdout.write('ready\n');
