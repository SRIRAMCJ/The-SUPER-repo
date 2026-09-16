import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskDecomposer } from '../src/index.js';

test('task decomposer creates a deterministic dependency order', () => {
  const decomposer = new TaskDecomposer({ clock: () => new Date('2026-01-01T00:00:00.000Z') });
  const plan = decomposer.decompose({
    goal: 'review repository',
    tasks: [
      { id: 'report', title: 'Write report', dependsOn: ['tests', 'scan'], priority: 2 },
      { id: 'scan', title: 'Scan repository', priority: 1, agent: 'agent/repository-analyst' },
      { id: 'tests', title: 'Inspect tests', priority: 1 }
    ]
  });

  assert.equal(plan.type, 'task-plan');
  assert.deepEqual(plan.order, ['scan', 'tests', 'report']);
  assert.equal(plan.tasks[2].position, 3);
  assert.equal(plan.tasks[0].agent, 'agent/repository-analyst');
});

test('task decomposer normalizes duplicate dependency edges without changing semantics', () => {
  const plan = new TaskDecomposer().decompose({
    goal: 'build artifact',
    tasks: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', dependsOn: ['a', 'a'] }
    ]
  });
  assert.deepEqual(plan.tasks[1].dependsOn, ['a']);
});

test('task decomposer rejects missing dependencies and cycles', () => {
  const decomposer = new TaskDecomposer();
  assert.throws(() => decomposer.decompose({ goal: 'x', tasks: [{ id: 'a', title: 'A', dependsOn: ['missing'] }] }), { code: 'TASK_DEPENDENCY_MISSING' });
  assert.throws(() => decomposer.decompose({ goal: 'x', tasks: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }] }), { code: 'TASK_DEPENDENCY_CYCLE' });
});

test('task decomposer requires explicit tasks instead of inventing execution steps', () => {
  assert.throws(() => new TaskDecomposer().decompose({ goal: 'review repository' }), { code: 'TASKS_MISSING' });
});
