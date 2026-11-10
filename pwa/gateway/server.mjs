import http from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const OLLAMA_PATHS = new Set(['/api/tags', '/api/chat', '/api/generate', '/api/show', '/api/ps']);
const MCP_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseOrigins(value = '') {
  return new Set(value.split(',').map(item => item.trim()).filter(Boolean));
}

function parseMcpServers(value = '{}') {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('MCP_SERVERS_JSON must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP_SERVERS_JSON must be an object.');
  for (const [id, item] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !item || typeof item.url !== 'string') throw new Error('Invalid MCP server configuration for ' + id);
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP server URLs must be HTTP(S) URLs without embedded credentials.');
  }
  return parsed;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body exceeds 2 MiB.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function applyCors(req, res, origins) {
  const origin = req.headers.origin;
  if (origin && origins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }
  return !origin || origins.has(origin);
}

function upstreamHeaders(req, extra = {}) {
  const headers = { accept: req.headers.accept || 'application/json', ...extra };
  for (const name of MCP_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  return headers;
}

export function createAxiomGateway({
  env = process.env,
  fetchImpl = fetch,
  logger = console
} = {}) {
  const token = env.AXIOM_GATEWAY_TOKEN;
  if (!token || token.length < 32) throw new Error('AXIOM_GATEWAY_TOKEN must be set to a random value of at least 32 characters.');
  const ollamaBase = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(ollamaBase.protocol) || ollamaBase.username || ollamaBase.password) throw new Error('OLLAMA_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  const origins = parseOrigins(env.AXIOM_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173');
  const mcpServers = parseMcpServers(env.MCP_SERVERS_JSON || '{}');

  const server = http.createServer(async (req, res) => {
    if (!applyCors(req, res, origins)) return sendJson(res, 403, { error: 'Origin not allowed.' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, service: 'axiom-gateway' });

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }

    if (url.pathname.startsWith('/api/ollama/')) {
      const upstreamPath = url.pathname.slice('/api/ollama'.length);
      if (!OLLAMA_PATHS.has(upstreamPath) || !['GET', 'POST'].includes(req.method)) return sendJson(res, 404, { error: 'Ollama route not allowed.' });
      const body = req.method === 'GET' ? undefined : await readBody(req).catch(error => {
        sendJson(res, error.status || 400, { error: error.message }); return null;
      });
      if (body === null) return;
      const target = new URL(upstreamPath + url.search, ollamaBase);
      try {
        const upstream = await fetchImpl(target, {
          method: req.method,
          headers: upstreamHeaders(req),
          body,
          signal: AbortSignal.timeout(120000)
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        return res.end();
      } catch (error) {
        logger.error?.('[axiom-gateway] Ollama upstream failed:', error.message);
        return sendJson(res, 502, { error: 'Ollama upstream unavailable.' });
      }
    }

    const mcpMatch = url.pathname.match(/^\/api\/mcp\/([a-zA-Z0-9_-]{1,64})$/);
    if (mcpMatch) {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed.' });
      const config = mcpServers[mcpMatch[1]];
      if (!config) return sendJson(res, 404, { error: 'MCP server is not configured in the gateway.' });
      const body = ['GET', 'DELETE'].includes(req.method) ? undefined : await readBody(req).catch(error => {
        sendJson(res, error.status || 400, { error: error.message }); return null;
      });
      if (body === null) return;
      const headers = upstreamHeaders(req, config.token ? { authorization: 'Bearer ' + config.token } : {});
      try {
        const upstream = await fetchImpl(config.url, { method: req.method, headers, body, signal: AbortSignal.timeout(120000) });
        const responseHeaders = {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        };
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
        res.writeHead(upstream.status, responseHeaders);
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        return res.end();
      } catch (error) {
        logger.error?.('[axiom-gateway] MCP upstream failed:', error.message);
        return sendJson(res, 502, { error: 'MCP upstream unavailable.' });
      }
    }

    return sendJson(res, 404, { error: 'Route not found.' });
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createAxiomGateway();
  const host = process.env.AXIOM_GATEWAY_HOST || '127.0.0.1';
  const port = Number(process.env.AXIOM_GATEWAY_PORT || 8787);
  server.listen(port, host, () => console.log('[axiom-gateway] listening on http://' + host + ':' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
