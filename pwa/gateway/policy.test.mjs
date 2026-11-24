import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpPolicy, inspectMcpToolCall, createAuditChain } from './policy.mjs';

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
});

test('audit log appends a verifiable hash-linked sequence and rejects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-audit-'));
  const path = join(directory, 'audit.jsonl');
  try {
    const audit = createAuditChain({ path, now: () => 1_800_000_000_000 });
    await audit.append({ action: 'mcp.tool', outcome: 'allowed' });
    await audit.append({ action: 'mcp.tool', outcome: 'denied' });
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].sequence, 1);
    assert.equal(rows[1].sequence, 2);
    assert.equal(rows[1].previousHash, rows[0].hash);
    const damaged = JSON.stringify({ ...rows[1], outcome: 'tampered' });
    await (await import('node:fs/promises')).writeFile(path, rows[0] ? JSON.stringify(rows[0]) + '\n' + damaged + '\n' : damaged);
    await assert.rejects(audit.append({ action: 'mcp.tool', outcome: 'allowed' }), /integrity/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
