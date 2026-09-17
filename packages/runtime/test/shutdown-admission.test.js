import { describe, expect, it } from 'vitest';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';

describe('RuntimeShutdownAdmission', () => {
  it('admits executions and blocks new work once draining begins', () => {
    let now = 1_000;
    const runtime = new RuntimeShutdownAdmission({ clock: () => now, idFactory: (prefix) => `${prefix}-${now}` });
    const admission = runtime.admit({ executionId: 'e1', metadata: { lane: 'interactive' } });
    expect(admission.executionId).toBe('e1');
    runtime.beginDrain({ deadlineMs: 100 });
    expect(() => runtime.admit({ executionId: 'e2' })).toThrowError(expect.objectContaining({ code: 'ADMISSION_CLOSED' }));
    expect(runtime.isAdmitted('e1')).toBe(true);
  });

  it('waits for active work and transitions to stopped after release', async () => {
    const runtime = new RuntimeShutdownAdmission({ clock: () => Date.now(), idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
    runtime.admit({ executionId: 'e1' });
    runtime.beginDrain({ deadlineMs: 500 });
    const waiting = runtime.waitForDrain({ deadlineMs: 500, pollMs: 1 });
    runtime.release('e1');
    const snapshot = await waiting;
    expect(snapshot.state).toBe('stopped');
    expect(snapshot.activeCount).toBe(0);
  });

  it('reports the exact remaining executions when the deadline expires', async () => {
    let now = 0;
    const runtime = new RuntimeShutdownAdmission({ clock: () => now, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
    runtime.admit({ executionId: 'e1' });
    runtime.beginDrain({ deadlineMs: 10 });
    const waiting = runtime.waitForDrain({ deadlineMs: 10, pollMs: 0 });
    now = 11;
    await expect(waiting).rejects.toMatchObject({ code: 'DRAIN_DEADLINE_EXCEEDED', remainingExecutions: ['e1'] });
  });

  it('keeps bounded immutable history and supports forced stop', () => {
    const runtime = new RuntimeShutdownAdmission({ historyLimit: 2, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
    runtime.admit({ executionId: 'e1' });
    runtime.beginDrain({ deadlineMs: 10 });
    runtime.forceStop();
    const history = runtime.history();
    expect(history).toHaveLength(2);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
    expect(runtime.state()).toBe('stopped');
  });

  it('rejects cancellation during drain without reopening admission', async () => {
    const runtime = new RuntimeShutdownAdmission({ clock: () => Date.now() });
    runtime.admit({ executionId: 'e1' });
    runtime.beginDrain({ deadlineMs: 500 });
    const controller = new AbortController();
    const waiting = runtime.waitForDrain({ deadlineMs: 500, pollMs: 50, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'DRAIN_CANCELLED' });
    expect(runtime.state()).toBe('draining');
    expect(() => runtime.admit({ executionId: 'e2' })).toThrowError(expect.objectContaining({ code: 'ADMISSION_CLOSED' }));
  });
});