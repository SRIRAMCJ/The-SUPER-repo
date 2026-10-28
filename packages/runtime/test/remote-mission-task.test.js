import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileMissionStore, FileExecutionStateStore, TaskDecomposer, TaskGraphExecutor, ExecutionStateStore, VerticalMissionEngine, createRemoteMissionTaskHandler } from '../src/index.js';

test('mission recovery uses the same remote request identity and verifies the result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-remote-mission-'));
  try {
    const calls = [];
    const coordinator = { execute: async (request) => {
      calls.push(request);
      if (calls.length === 1) throw Object.assign(new Error('worker connection lost'), { code: 'REMOTE_CONNECTION_CLOSED' });
      return { doubled: request.input.value * 2 };
    } };
    const graph = new TaskGraphExecutor({ stateStore: new ExecutionStateStore(), executeTask: createRemoteMissionTaskHandler({ coordinator }) });
    const missionStore = await new FileMissionStore(path.join(directory, 'missions.json')).init();
    const verifier = { verify: ({ output }) => ({ verified: output.output.doubled === 42, checks: 1, failures: [] }) };
    const engine = new VerticalMissionEngine({ taskDecomposer: new TaskDecomposer(), taskGraphExecutor: graph, missionStore, verifier });
    const mission = { kind: 'mission', id: 'mission/remote', goal: 'double input', tasks: [
      { id: 'compute', title: 'Compute', dependsOn: [], capabilities: ['math.double'], input: { value: 21 } }
    ] };
    const first = await engine.execute(mission, {}, { executionId: 'mission-1' });
    assert.equal(first.status, 'executing');
    assert.equal(first.result.results[0].error.retryable, true);
    const recovered = await engine.recover('mission-1', { resume: true });
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.verification.verified, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].requestId, calls[1].requestId);
    assert.equal(calls[0].executionId, calls[1].executionId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('remote task handler rejects ambiguous capability selection', async () => {
  const handler = createRemoteMissionTaskHandler({ coordinator: { execute: async () => 'never' } });
  await assert.rejects(handler({ id: 'task', capabilities: ['one', 'two'] }, {}, { executionId: 'run' }), { code: 'REMOTE_TASK_INVALID' });
});

test('a new mission host resumes remote task state after process-style restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-remote-restart-'));
  try {
    const dispatched = [];
    const coordinator = { execute: async (request) => {
      dispatched.push(request.requestId);
      if (dispatched.length === 1) throw Object.assign(new Error('uncertain remote outcome'), { code: 'REMOTE_RECOVERY_REQUIRED' });
      return { value: 42 };
    } };
    const missionPath = path.join(directory, 'missions.json');
    const graphPath = path.join(directory, 'graph.json');
    const makeHost = async () => new VerticalMissionEngine({ taskDecomposer: new TaskDecomposer(),
      taskGraphExecutor: new TaskGraphExecutor({ stateStore: new FileExecutionStateStore(graphPath), executeTask: createRemoteMissionTaskHandler({ coordinator }) }),
      missionStore: await new FileMissionStore(missionPath).init(),
      verifier: { verify: ({ output }) => ({ verified: output.output.value === 42, checks: 1, failures: [] }) } });
    const manifest = { kind: 'mission', id: 'mission/restart', goal: 'remote restart', tasks: [
      { id: 'task', title: 'Task', capabilities: ['compute'], input: { value: 21 } }
    ] };
    const firstHost = await makeHost();
    assert.equal((await firstHost.execute(manifest, {}, { executionId: 'restart-1' })).status, 'executing');
    const secondHost = await makeHost();
    const recovered = await secondHost.recover('restart-1', { resume: true });
    assert.equal(recovered.status, 'succeeded');
    assert.deepEqual(dispatched, [dispatched[0], dispatched[0]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
