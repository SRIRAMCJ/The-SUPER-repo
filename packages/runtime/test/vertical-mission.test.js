import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileMissionStore } from '../src/mission-store.js';
import { TaskDecomposer } from '../src/task-decomposer.js';
import { TaskGraphExecutor } from '../src/task-graph-executor.js';
import { ExecutionStateStore } from '../src/state.js';
import { VerificationEngine } from '../src/verification.js';
import { VerticalMissionEngine } from '../src/vertical-mission.js';

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-vertical-'));
  const missionStore = await new FileMissionStore(path.join(directory, 'missions.json')).init();
  const stateStore = new ExecutionStateStore();
  return { missionStore, stateStore };
}

function mission() {
  return {
    kind: 'mission',
    id: 'mission/test',
    goal: 'complete a test mission',
    tasks: [
      { id: 'inspect', title: 'Inspect', dependsOn: [] },
      { id: 'build', title: 'Build', dependsOn: ['inspect'] }
    ]
  };
}

test('vertical mission persists lifecycle and verifies success', async () => {
  const { missionStore, stateStore } = await setup();
  const graph = new TaskGraphExecutor({ stateStore, executeTask: async (task) => ({ task: task.id }) });
  const engine = new VerticalMissionEngine({
    taskDecomposer: new TaskDecomposer(),
    taskGraphExecutor: graph,
    missionStore,
    verifier: new VerificationEngine()
  });
  const result = await engine.execute(mission());
  assert.equal(result.status, 'succeeded');
  assert.equal(result.verification.verified, true);
  assert.equal((await engine.get(result.missionExecutionId)).status, 'succeeded');
});

test('vertical mission recovery resumes unfinished graph work', async () => {
  const { missionStore, stateStore } = await setup();
  const calls = [];
  let fail = true;
  const graph = new TaskGraphExecutor({
    stateStore,
    executeTask: async (task) => {
      calls.push(task.id);
      if (task.id === 'build' && fail) {
        fail = false;
        throw Object.assign(new Error('transient'), { code: 'TRANSIENT', retryable: true });
      }
      return { task: task.id };
    }
  });
  const engine = new VerticalMissionEngine({
    taskDecomposer: new TaskDecomposer(),
    taskGraphExecutor: graph,
    missionStore
  });
  const first = await engine.execute(mission());
  assert.equal(first.status, 'executing');
  assert.deepEqual(calls, ['inspect', 'build']);
  const inspection = await engine.recover(first.missionExecutionId);
  assert.equal(inspection.recovery.resumable, true);
  const recovered = await engine.recover(first.missionExecutionId, { resume: true });
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(calls, ['inspect', 'build', 'build']);
  assert.equal(recovered.recovery.resumed, true);
});

test('terminal missions cannot be resumed', async () => {
  const { missionStore, stateStore } = await setup();
  const graph = new TaskGraphExecutor({ stateStore, executeTask: async () => ({ ok: true }) });
  const engine = new VerticalMissionEngine({ taskDecomposer: new TaskDecomposer(), taskGraphExecutor: graph, missionStore });
  const result = await engine.execute(mission());
  const recovered = await engine.recover(result.missionExecutionId, { resume: true });
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recovery.resumable, false);
});

test('durable recovery leases fence concurrent recovery claims', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-vertical-fence-'));
  const missionPath = path.join(directory, 'missions.json');
  const storeA = await new FileMissionStore(missionPath).init();
  const storeB = await new FileMissionStore(missionPath).init();
  const record = await storeA.save({
    type: 'vertical-mission',
    missionId: 'mission/fenced',
    missionExecutionId: 'exec/fenced',
    status: 'executing',
    plan: { type: 'task-plan', schemaVersion: '0.1.0', taskCount: 1, tasks: [{ id: 'build', dependsOn: [] }], order: ['build'] }
  });
  const claimed = await storeA.claimRecovery(record.missionExecutionId, 'worker-a', 30000);
  assert.equal(claimed.recoveryLease.owner, 'worker-a');
  await assert.rejects(
    () => storeB.claimRecovery(record.missionExecutionId, 'worker-b', 30000),
    (error) => error.code === 'MISSION_RECOVERY_LEASE_HELD'
  );
  const released = await storeA.releaseRecovery(record.missionExecutionId, 'worker-a');
  assert.equal(released.recoveryLease, null);
  const reclaimed = await storeB.claimRecovery(record.missionExecutionId, 'worker-b', 30000);
  assert.equal(reclaimed.recoveryLease.owner, 'worker-b');
});


test('vertical mission restart preserves durable recovery lease fencing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-vertical-lease-restart-'));
  const missionPath = path.join(directory, 'missions.json');
  const first = await new FileMissionStore(missionPath).init();
  const record = await first.save({
    missionId: 'mission/restart-lease',
    missionExecutionId: 'exec/restart-lease',
    type: 'vertical-mission',
    status: 'executing',
    recovery: { status: 'available', resumable: true }
  });
  await first.claimRecovery(record.missionExecutionId, 'worker-a', 30000);

  const restarted = await new FileMissionStore(missionPath).init();
  const engine = new VerticalMissionEngine({
    taskDecomposer: new TaskDecomposer(),
    taskGraphExecutor: new TaskGraphExecutor({
      stateStore: new ExecutionStateStore(),
      executeTask: async () => ({ ok: true })
    }),
    missionStore: restarted
  });

  await assert.rejects(
    () => engine.recover(record.missionExecutionId, { resume: true, owner: 'worker-b' }),
    (error) => error.code === 'MISSION_RECOVERY_LEASE_HELD'
  );
});
