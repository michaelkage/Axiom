import { randomBytes, randomUUID } from 'node:crypto';

const INVITE_TTL_MS = 90_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const MAX_APPROVALS = 500;
const CAPABILITIES = new Set(['shell.execute', 'workspace.write', 'git.integrate', 'tool.execute']);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function boundedString(value, max, label, required = true) {
  if (typeof value !== 'string') fail(label + ' must be a string.');
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > max) fail(label + ' is invalid.');
  return normalized;
}

export function createCompanionCoordinator({ now = Date.now } = {}) {
  const invites = new Map();
  const sessions = new Map();
  const approvals = new Map();

  function prune() {
    const timestamp = now();
    for (const [code, invite] of invites) if (invite.expiresAt <= timestamp) invites.delete(code);
    for (const [token, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(token);
    for (const [id, approval] of approvals) {
      if (approval.expiresAt <= timestamp && approval.status === 'pending') {
        approval.status = 'expired';
        approval.decidedAt = timestamp;
      }
      if (approval.expiresAt + APPROVAL_TTL_MS <= timestamp) approvals.delete(id);
    }
  }

  function createInvite(ownerToken) {
    if (typeof ownerToken !== 'string' || ownerToken.length < 32) fail('An authenticated gateway session is required.', 401);
    prune();
    if (invites.size >= 100) fail('Too many active pairing requests. Try again shortly.', 429);
    let code;
    do { code = String(10_000_000 + (randomBytes(4).readUInt32BE(0) % 90_000_000)); } while (invites.has(code));
    invites.set(code, { ownerToken, expiresAt: now() + INVITE_TTL_MS });
    return { code, expiresIn: Math.floor(INVITE_TTL_MS / 1000) };
  }

  function claimInvite(input = {}) {
    prune();
    const code = boundedString(input.code, 8, 'Pairing code');
    if (!/^\d{8}$/.test(code)) fail('Pairing code is invalid.', 401);
    const invite = invites.get(code);
    if (!invite) fail('Pairing code is invalid, expired, or already used.', 401);
    invites.delete(code);
    const deviceName = boundedString(input.deviceName ?? 'Axiom mobile', 64, 'Device name');
    const token = randomBytes(32).toString('hex');
    const pairId = randomUUID();
    const expiresAt = now() + SESSION_TTL_MS;
    sessions.set(token, { pairId, ownerToken: invite.ownerToken, deviceName, expiresAt });
    return { token, pairId, deviceName, expiresIn: Math.floor(SESSION_TTL_MS / 1000) };
  }

  function createApproval(token, input = {}) {
    prune();
    const session = sessions.get(token);
    if (!session) fail('A paired companion session is required.', 403);
    const capability = boundedString(input.capability, 64, 'Capability');
    if (!CAPABILITIES.has(capability)) fail('Requested capability is not supported.');
    const summary = boundedString(input.summary, 500, 'Approval summary');
    const command = boundedString(input.command ?? '', 2000, 'Command', false);
    const resource = boundedString(input.resource ?? '', 500, 'Resource', false);
    if (approvals.size >= MAX_APPROVALS) fail('Approval queue is full. Resolve existing requests first.', 429);
    const id = randomUUID();
    const timestamp = now();
    const approval = {
      id,
      pairId: session.pairId,
      ownerToken: session.ownerToken,
      requesterToken: token,
      deviceName: session.deviceName,
      capability,
      summary,
      command,
      resource,
      status: 'pending',
      createdAt: timestamp,
      expiresAt: timestamp + APPROVAL_TTL_MS,
      decidedAt: null
    };
    approvals.set(id, approval);
    return publicApproval(approval);
  }

  function publicApproval(item) {
    const { ownerToken, requesterToken, ...safe } = item;
    return { ...safe };
  }

  function listApprovals(ownerToken) {
    prune();
    return [...approvals.values()]
      .filter(item => item.ownerToken === ownerToken)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicApproval);
  }

  function decideApproval(ownerToken, id, decision) {
    prune();
    if (!['approved', 'denied'].includes(decision)) fail('Decision must be approved or denied.');
    const approval = approvals.get(id);
    if (!approval || approval.ownerToken !== ownerToken) fail('Approval request was not found.', 404);
    if (approval.status !== 'pending') fail('Approval request is no longer pending.', 409);
    if (approval.expiresAt <= now()) {
      approval.status = 'expired';
      approval.decidedAt = now();
      fail('Approval request has expired.', 409);
    }
    approval.status = decision;
    approval.decidedAt = now();
    return publicApproval(approval);
  }

  function getApproval(token, id) {
    prune();
    const approval = approvals.get(id);
    if (!approval || approval.requesterToken !== token) fail('Approval request was not found.', 404);
    return publicApproval(approval);
  }

  function revokePair(ownerToken, pairId) {
    const removedTokens = [];
    for (const [token, session] of sessions) {
      if (session.ownerToken === ownerToken && session.pairId === pairId) {
        sessions.delete(token);
        removedTokens.push(token);
      }
    }
    for (const [id, approval] of approvals) {
      if (approval.ownerToken === ownerToken && approval.pairId === pairId) approvals.delete(id);
    }
    return removedTokens;
  }

  return Object.freeze({ createInvite, claimInvite, createApproval, listApprovals, decideApproval, getApproval, revokePair });
}
