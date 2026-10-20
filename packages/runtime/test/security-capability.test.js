import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityCapabilityGate } from '../src/security-capability.js';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';

const capability = (overrides = {}) => ({ id: 'tool/secure', name: 'Secure Tool', risk: 'low', permissions: [], ...overrides });
const context = (overrides = {}) => ({ trustLevel: 'trusted', grantedPermissions: [], ...overrides });

test('security gate fails closed on malformed trust context and protected overrides', () => {
  const gate = new SecurityCapabilityGate();
  assert.equal(gate.authorize(capability(), {}).decision, 'invalid');
  assert.equal(gate.authorize(capability(), context({ allowed: true })).allowed, false);
  assert.equal(gate.authorize(capability(), context({ grantedPermissions: ['network'], network: true })).allowed, false);
});

test('security gate requires declared and explicitly granted permissions', () => {
  const gate = new SecurityCapabilityGate();
  assert.equal(gate.authorize(capability({ permissions: ['filesystem'] }), context()).allowed, false);
  assert.equal(gate.authorize(capability({ permissions: ['filesystem'] }), context({ grantedPermissions: ['filesystem'] })).allowed, true);
  assert.equal(gate.authorize(capability({ permissions: ['network'] }), context({ grantedPermissions: ['network'] })).allowed, false);
  assert.equal(gate.authorize(capability({ permissions: ['network'] }), context({ grantedPermissions: ['network'], network: true })).allowed, true);
  assert.equal(gate.authorize(capability({ permissions: ['unknown'] }), context({ grantedPermissions: ['unknown'] })).allowed, false);
});

test('security gate honors policy and trust denial and bounds detached audit records', () => {
  const gate = new SecurityCapabilityGate({ policyEngine: { authorize: () => ({ allowed: false, reason: 'policy-denied' }) }, maxDecisions: 2 });
  assert.equal(gate.authorize(capability(), context()).detail, 'policy-denied');
  assert.equal(gate.authorize(capability({ risk: 'critical' }), context({ trustLevel: 'untrusted' })).decision, 'denied');
  gate.authorize(capability({ id: 'last' }), context());
  const records = gate.getDecisions();
  assert.equal(records.length, 2);
  records[0].capabilityId = 'changed';
  assert.equal(gate.getDecisions()[0].capabilityId, 'tool/secure');
});

test('tool runtime checks the security gate before invoking a handler', async () => {
  const registry = new CapabilityRegistry();
  let calls = 0;
  registry.register({ schemaVersion: '0.1.0', id: 'tool/secure', kind: 'tool', name: 'Secure Tool', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' } }, async () => { calls++; return 'executed'; });
  const runtime = new ToolRuntime({ registry, securityGate: new SecurityCapabilityGate() });
  assert.equal((await runtime.execute('tool/secure', {}, {})).error.code, 'SECURITY_INVALID_CONTEXT');
  assert.equal(calls, 0);
  const result = await runtime.execute('tool/secure', {}, context());
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 'executed');
  assert.equal(calls, 1);
});
