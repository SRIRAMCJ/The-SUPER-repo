import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProtocolEnvelope,
  validateProtocolEnvelope,
  negotiateProtocol,
  RemoteProtocolSession,
} from '../src/remote-execution-protocol.js';

test('negotiates a common protocol version', () => {
  assert.deepEqual(negotiateProtocol({ offered: ['0.9', '1.0'], supported: ['1.0'] }), {
    state: 'negotiated',
    protocolVersion: '1.0',
  });
});

test('rejects incompatible protocol versions', () => {
  assert.equal(negotiateProtocol({ offered: ['2.0'], supported: ['1.0'] }).code, 'UNSUPPORTED_PROTOCOL_VERSION');
});

test('validates envelope and deadline', () => {
  const envelope = createProtocolEnvelope({ requestId: 'req-1', method: 'execute', timestamp: 1000, deadlineAt: 2000 });
  assert.equal(validateProtocolEnvelope(envelope, { now: 1500 }).ok, true);
  assert.equal(validateProtocolEnvelope(envelope, { now: 2500 }).code, 'DEADLINE_EXCEEDED');
});

test('session rejects duplicate requests', () => {
  const session = new RemoteProtocolSession({ clock: () => 1000 });
  assert.equal(session.negotiate(['1.0']).state, 'negotiated');
  const envelope = createProtocolEnvelope({ requestId: 'req-1', method: 'execute', timestamp: 1000 });
  assert.equal(session.accept(envelope).ok, true);
  assert.equal(session.accept(envelope).code, 'DUPLICATE_REQUEST');
});


test('protocol negotiation follows local supported-version preference', () => {
  assert.equal(negotiateProtocol({ offered: ['1.0', '2.0'], supported: ['2.0', '1.0'] }).protocolVersion, '1.0');
});

test('protocol validation rejects malformed deadline, execution id, and payload', () => {
  const base = createProtocolEnvelope({ requestId: 'validate-1', method: 'execute', payload: {} });
  assert.equal(validateProtocolEnvelope({ ...base, deadlineAt: 'invalid' }).code, 'INVALID_DEADLINE');
  assert.equal(validateProtocolEnvelope({ ...base, executionId: 42 }).code, 'INVALID_EXECUTION_ID');
  assert.equal(validateProtocolEnvelope({ ...base, payload: [] }).code, 'INVALID_PAYLOAD');
});

test('protocol validation does not accept a non-finite deadline', () => {
  const base = createProtocolEnvelope({ requestId: 'validate-2', method: 'execute', payload: {} });
  assert.equal(validateProtocolEnvelope({ ...base, deadlineAt: Infinity }).code, 'INVALID_DEADLINE');
});
