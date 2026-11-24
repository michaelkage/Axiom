import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeMcpTarget } from './network-policy.mjs';

test('rejects loopback, link-local, private, reserved and metadata IP literals', async () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '224.0.0.1', '[::1]', '[fe80::1]', '[fd00::1]', '[2001:db8::1]']) {
    await assert.rejects(assertSafeMcpTarget('http://' + address + '/mcp'), /private|non-public|local hostname/i, address);
  }
});

test('accepts public IP literals and rejects non-HTTP schemes or URL credentials', async () => {
  await assert.doesNotReject(assertSafeMcpTarget('https://1.1.1.1/mcp'));
  await assert.rejects(assertSafeMcpTarget('file:///etc/passwd'), /HTTP/);
  await assert.rejects(assertSafeMcpTarget('https://user:pass@example.com/mcp'), /credentials/);
});

test('private destinations require an exact explicit host exception', async () => {
  await assert.rejects(assertSafeMcpTarget('http://127.0.0.1:8787/mcp'), /private|non-public/i);
  await assert.doesNotReject(assertSafeMcpTarget('http://127.0.0.1:8787/mcp', new Set(['127.0.0.1'])));
  await assert.rejects(assertSafeMcpTarget('http://localhost:8787/mcp'), /local hostname/i);
  await assert.doesNotReject(assertSafeMcpTarget('http://localhost:8787/mcp', new Set(['localhost'])));
});
