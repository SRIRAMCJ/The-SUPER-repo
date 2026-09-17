import { describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '../src/policy.js';
import { SecurityCapabilityGate } from '../src/security-capability.js';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';

const capability = (overrides = {}) => ({
  id: 'tool/secure', name: 'Secure Tool', risk: 'low', permissions: [], ...overrides,
});

const context = (overrides = {}) => ({ trustLevel: 'trusted', grantedPermissions: [], ...overrides });

describe('SecurityCapabilityGate', () => {
  it('denies malformed or missing trust context by default', () => {
    const gate = new SecurityCapabilityGate({ idFactory: () => 'sec-1', clock: () => new Date('2026-01-01T00:00:00.000Z') });
    expect(gate.authorize(capability(), {})).toMatchObject({ decisionId: 'sec-1', decision: 'invalid', allowed: false });
    expect(gate.authorize(capability(), { trustLevel: 'trusted', allowed: true })).toMatchObject({ decision: 'invalid', allowed: false });
  });

  it('prevents privilege escalation through undeclared permissions', () => {
    const gate = new SecurityCapabilityGate({ idFactory: () => 'sec-2' });
    expect(gate.authorize(capability(), context({ grantedPermissions: ['network'], network: true }))).toMatchObject({ decision: 'invalid', allowed: false });
  });

  it('requires explicit network authorization', () => {
    const gate = new SecurityCapabilityGate({ idFactory: () => 'sec-3' });
    expect(gate.authorize(capability({ permissions: ['network'] }), context({ grantedPermissions: ['network'] }))).toMatchObject({ decision: 'invalid', allowed: false });
    expect(gate.authorize(capability({ permissions: ['network'] }), context({ grantedPermissions: ['network'], network: true }))).toMatchObject({ decision: 'allowed', allowed: true });
  });

  it('delegates policy denial without allowing caller context to bypass it', () => {
    const policyEngine = new PolicyEngine({ policies: [() => ({ allowed: false, reason: 'policy-denied' })] });
    const gate = new SecurityCapabilityGate({ policyEngine, idFactory: () => 'sec-4' });
    expect(gate.authorize(capability(), context({ approval: true }))).toMatchObject({ decision: 'denied', allowed: false, detail: 'policy-denied' });
  });

  it('blocks critical capabilities from untrusted execution', () => {
    const gate = new SecurityCapabilityGate({ idFactory: () => 'sec-5' });
    expect(gate.authorize(capability({ risk: 'critical' }), context({ trustLevel: 'untrusted' }))).toMatchObject({ decision: 'denied', allowed: false });
  });

  it('retains immutable bounded decisions', () => {
    const gate = new SecurityCapabilityGate({ maxDecisions: 2, idFactory: (id) => id });
    gate.authorize(capability({ id: 'a' }), context());
    gate.authorize(capability({ id: 'b' }), context());
    gate.authorize(capability({ id: 'c' }), context());
    const decisions = gate.getDecisions();
    expect(decisions.map((item) => item.capabilityId)).toEqual(['b', 'c']);
    decisions[0].capabilityId = 'tampered';
    expect(gate.getDecisions()[0].capabilityId).toBe('b');
  });

  it('is enforced by ToolRuntime before a handler runs', async () => {
    const registry = new CapabilityRegistry();
    const handler = vi.fn(async () => 'executed');
    registry.register({ schemaVersion: '0.1.0', id: 'tool/secure', kind: 'tool', name: 'Secure Tool', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' } }, handler);
    const gate = new SecurityCapabilityGate({ idFactory: () => 'sec-7' });
    const runtime = new ToolRuntime({ registry, securityGate: gate, idFactory: () => 'exec-7' });
    await expect(runtime.execute('tool/secure', {}, {})).resolves.toMatchObject({ error: { code: 'SECURITY_INVALID_CONTEXT' } });
    expect(handler).not.toHaveBeenCalled();
    await expect(runtime.execute('tool/secure', {}, context())).resolves.toMatchObject({ status: 'succeeded', output: 'executed' });
    expect(handler).toHaveBeenCalledOnce();
  });
});
