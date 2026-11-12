import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionCoordinator } from '../gateway/companion.js';

const token = 'a'.repeat(64);

test('pairing codes are short-lived, single-use and issue isolated session credentials', () => {
  let time = 1000;
  const companion = createCompanionCoordinator({ now: () => time });
  const invite = companion.createInvite(token);
  assert.match(invite.code, /^\\d{8}$/);
  const claimed = companion.claimInvite({ code: invite.code, deviceName: 'Android phone' });
  assert.equal(claimed.deviceName, 'Android phone');
  assert.equal(claimed.expiresIn, 43200);
  assert.notEqual(claimed.token, token);
  assert.throws(() => companion.claimInvite({ code: invite.code }), /invalid, expired, or already used/);
  time += 91_000;
  const expired = companion.createInvite(token);
  time += 91_000;
  assert.throws(() => companion.claimInvite({ code: expired.code }), /invalid, expired, or already used/);
});

test('only paired devices can request supported capabilities and owners can decide', () => {
  const companion = createCompanionCoordinator();
  const invite = companion.createInvite(token);
  const device = companion.claimInvite({ code: invite.code });
  assert.throws(() => companion.createApproval(token, { capability: 'shell.execute', summary: 'Run tests' }), /paired companion session/);
  assert.throws(() => companion.createApproval(device.token, { capability: 'arbitrary.root', summary: 'Do anything' }), /not supported/);
  const approval = companion.createApproval(device.token, {
    capability: 'shell.execute',
    summary: 'Run the project test suite',
    command: 'npm test',
    resource: 'workspace'
  });
  assert.equal(approval.status, 'pending');
  assert.equal(approval.command, 'npm test');
  assert.equal('ownerToken' in approval, false);
  assert.equal(companion.listApprovals(token).length, 1);
  assert.throws(() => companion.decideApproval('b'.repeat(64), approval.id, 'approved'), /not found/);
  const decided = companion.decideApproval(token, approval.id, 'approved');
  assert.equal(decided.status, 'approved');
  assert.equal(companion.getApproval(device.token, approval.id).status, 'approved');
  assert.throws(() => companion.decideApproval(token, approval.id, 'denied'), /no longer pending/);
});

test('pair revocation invalidates its approval access and approval requests are bounded', () => {
  const companion = createCompanionCoordinator();
  const invite = companion.createInvite(token);
  const device = companion.claimInvite({ code: invite.code });
  const approval = companion.createApproval(device.token, { capability: 'workspace.write', summary: 'Update a file' });
  assert.equal(companion.revokePair(token, device.pairId), true);
  assert.throws(() => companion.createApproval(device.token, { capability: 'workspace.write', summary: 'Again' }), /paired companion session/);
  assert.throws(() => companion.getApproval(device.token, approval.id), /not found/);
});
