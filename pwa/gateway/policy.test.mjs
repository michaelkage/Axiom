import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpPolicy, inspectMcpToolCall, createAuditChain } from './policy.mjs';

const SIGNING_KEY = 'a'.repeat(64);

test('MCP policy requires explicit unique tool allowlists', () => {
  assert.throws(() => parseMcpPolicy('{"server":{}}'), /allowedTools/);
  assert.throws(() => parseMcpPolicy('{"server":{"allowedTools":["x","x"]}}'), /unique/);
  const policy = parseMcpPolicy('{"server":{"allowedTools":["read_file"]}}');
  assert.equal(policy.server.allowedTools.has('read_file'), true);
  assert.equal(policy.server.allowedTools.has('delete_file'), false);
});

test('only valid JSON-RPC tools/call requests are classified', () => {
  assert.deepEqual(inspectMcpToolCall(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}')), {
    invalid: false, name: 'read_file', requestId: 1
  });
  assert.equal(inspectMcpToolCall(Buffer.from('{"method":"tools/list"}')), null);
  assert.equal(inspectMcpToolCall(Buffer.from('{"method":"tools/call","params":{"name":"../secret"}}')).invalid, true);
  assert.equal(inspectMcpToolCall(Buffer.from('[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}]')).invalid, true);
});

test('audit records are HMAC-signed, hash-linked and reject tampering or a wrong key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-audit-'));
  const path = join(directory, 'audit.jsonl');
  try {
    const audit = createAuditChain({ path, key: SIGNING_KEY, now: () => 1_800_000_000_000 });
    await audit.append({ action: 'mcp.tool', outcome: 'allowed' });
    await audit.append({ action: 'mcp.tool', outcome: 'denied' });
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].version, 2);
    assert.equal(rows[0].sequence, 1);
    assert.equal(rows[1].sequence, 2);
    assert.equal(rows[1].previousHash, rows[0].hash);
    const expected = createHmac('sha256', SIGNING_KEY).update(JSON.stringify((({ hash, ...payload }) => payload)(rows[0]))).digest('hex');
    assert.equal(rows[0].hash, expected);
    await assert.rejects(
      createAuditChain({ path, key: 'b'.repeat(64) }).append({ action: 'mcp.tool' }),
      /integrity/
    );
    const damaged = JSON.stringify({ ...rows[1], outcome: 'tampered' });
    await writeFile(path, JSON.stringify(rows[0]) + '\n' + damaged + '\n');
    await assert.rejects(audit.append({ action: 'mcp.tool', outcome: 'allowed' }), /integrity/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('valid legacy SHA-256 logs are migrated to HMAC records before appending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-audit-migrate-'));
  const path = join(directory, 'audit.jsonl');
  try {
    const firstPayload = {
      action: 'mcp.tool',
      outcome: 'allowed',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      previousHash: '0'.repeat(64)
    };
    const firstHash = createHash('sha256').update(JSON.stringify(firstPayload)).digest('hex');
    const secondPayload = {
      action: 'mcp.tool',
      outcome: 'denied',
      sequence: 2,
      timestamp: '2026-01-01T00:00:01.000Z',
      previousHash: firstHash
    };
    const secondHash = createHash('sha256').update(JSON.stringify(secondPayload)).digest('hex');
    await writeFile(path, JSON.stringify({ ...firstPayload, hash: firstHash }) + '\n' +
      JSON.stringify({ ...secondPayload, hash: secondHash }) + '\n');
    const audit = createAuditChain({ path, key: SIGNING_KEY, now: () => 1_800_000_000_000 });
    await audit.append({ action: 'mcp.tool', outcome: 'allowed' });
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.version === 2));
    assert.equal(rows[0].sequence, 1);
    assert.equal(rows[1].sequence, 2);
    assert.equal(rows[1].previousHash, rows[0].hash);
    assert.equal(rows[2].sequence, 3);
    assert.equal(rows[2].previousHash, rows[1].hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit chain refuses a signing key shorter than 32 bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-audit-key-'));
  try {
    assert.throws(() => createAuditChain({ path: join(directory, 'audit.jsonl'), key: 'short' }), /32 bytes/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
