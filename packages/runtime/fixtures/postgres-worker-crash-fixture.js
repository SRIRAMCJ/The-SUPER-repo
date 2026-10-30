import { Pool } from 'pg';
import { UnixWorkerServer } from '../src/unix-worker-transport.js';
import { RemoteWorkerAuthenticator } from '../src/remote-worker-auth.js';
import { PostgresCoordinationStore } from '../src/postgres-coordination.js';
import { PostgresWorkerIdempotencyStore, PostgresWorkerAuditJournal } from '../src/postgres-worker-stores.js';

const pool = new Pool({ connectionString: process.env.SUPER_TEST_POSTGRES_URL });
const coordinator = await new PostgresCoordinationStore(pool).init();
const server = new UnixWorkerServer({ socketPath: process.env.SUPER_TEST_SOCKET, nodeId: 'node-1',
  authenticator: new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 11) }), nonceStore: coordinator,
  idempotencyStore: await new PostgresWorkerIdempotencyStore(pool, { ttlMs: 1000 }).init(),
  auditJournal: await new PostgresWorkerAuditJournal(pool).init(), authorize: () => ({ allowed: true }),
  handlers: { commitThenCrash: async (input) => {
    await coordinator.writeFencedEffect(input.effectKey, input.fence, { value: 1 });
    process.exit(23);
  } } });
await server.start();
process.send?.('ready');
