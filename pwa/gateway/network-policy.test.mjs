import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertSafeMcpTarget, fetchSafeMcpTarget } from './network-policy.mjs';

test('rejects loopback, link-local, private, reserved and metadata IP literals', async () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '224.0.0.1', '[::1]', '[fe80::1]', '[fd00::1]', '[2001:db8::1]', '[2001:2::1]', '[3fff::1]']) {
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

test('returns a bodyless response for HTTP 205 without violating the Fetch Response contract', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(205);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetchSafeMcpTarget(
      'http://mcp.test:' + port + '/mcp',
      { method: 'GET', redirect: 'error' },
      new Set(['mcp.test']),
      globalThis.fetch,
      async () => [{ address: '127.0.0.1', family: 4 }]
    );
    assert.equal(response.status, 205);
    assert.equal(response.body, null);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('pins the validated DNS answer to the actual upstream socket', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.headers.host);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    let resolutions = 0;
    const response = await fetchSafeMcpTarget(
      'http://mcp.test:' + port + '/mcp',
      { method: 'GET', redirect: 'error' },
      new Set(['mcp.test']),
      globalThis.fetch,
      async (hostname, options) => {
        resolutions += 1;
        assert.equal(hostname, 'mcp.test');
        assert.equal(options.all, true);
        return [{ address: '127.0.0.1', family: 4 }];
      }
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'mcp.test:' + port);
    assert.equal(resolutions, 1, 'the hostname must be resolved once and the answer reused by the socket');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
