import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const ip = ipv4Number(address);
  const ranges = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
  ];
  return !ranges.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (ipv4Number(base) & mask);
  });
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  // Permit only global-unicast 2000::/3. Exclude transition, documentation,
  // benchmarking, and ORCHID ranges whose embedded routing can be misleading.
  if (!/^[23]/.test(normalized)) return false;
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:10:') ||
      normalized.startsWith('2001:20:') || normalized.startsWith('2002:') ||
      normalized.startsWith('2001:0:')) return false;
  return true;
}

async function resolveSafeTarget(value, allowedPrivateHosts = new Set(), lookupImpl = lookup) {
  const target = value instanceof URL ? new URL(value.href) : new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('MCP endpoint must be HTTP(S) without embedded credentials.');
  }
  const rawHostname = target.hostname.toLowerCase().replaceAll('[', '').replaceAll(']', '');
  const hostname = rawHostname.endsWith('.') ? rawHostname.slice(0, -1) : rawHostname;
  const explicitlyAllowed = allowedPrivateHosts.has(hostname);
  if (!explicitlyAllowed && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) {
    throw new Error('MCP endpoint resolves to a local hostname; add its exact hostname to AXIOM_MCP_ALLOWED_PRIVATE_HOSTS only if intentionally trusted.');
  }
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || (!explicitlyAllowed && addresses.some(entry => !isPublicAddress(entry.address)))) {
    throw new Error('MCP endpoint resolves to a private, reserved, or non-public network address.');
  }
  return { target, hostname, addresses };
}

export async function assertSafeMcpTarget(value, allowedPrivateHosts = new Set()) {
  const { target } = await resolveSafeTarget(value, allowedPrivateHosts);
  return target;
}

/**
 * Resolve and pin an upstream destination for the lifetime of a single socket.
 * The HTTP agent's lookup callback returns only the addresses validated above,
 * preventing a second DNS resolution (and DNS-rebinding between check/connect).
 * Redirects are never followed by this transport.
 */
export async function fetchSafeMcpTarget(value, options = {}, allowedPrivateHosts = new Set(), fetchImpl = globalThis.fetch, lookupImpl = lookup) {
  const { target, hostname, addresses } = await resolveSafeTarget(value, allowedPrivateHosts, lookupImpl);
  // Preserve injectable transports for deterministic unit tests; production uses
  // Node's native fetch and the pinned socket path below.
  if (fetchImpl !== globalThis.fetch) {
    return fetchImpl(target, { ...options, redirect: 'error' });
  }
  if (options.redirect && options.redirect !== 'error') throw new Error('MCP upstream redirects are disabled.');
  if (options.body !== undefined && options.body !== null &&
      typeof options.body !== 'string' && !Buffer.isBuffer(options.body) && !(options.body instanceof Uint8Array)) {
    throw new TypeError('Pinned MCP transport accepts only buffered request bodies.');
  }
  const address = addresses[0];
  const pinnedLookup = (_hostname, lookupOptions, callback) => {
    if (lookupOptions?.all) return callback(null, addresses);
    callback(null, address.address, address.family);
  };
  const secure = target.protocol === 'https:';
  const agent = secure
    ? new https.Agent({ keepAlive: false, lookup: pinnedLookup })
    : new http.Agent({ keepAlive: false, lookup: pinnedLookup });
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : { ...(options.headers || {}) };
  const request = (secure ? https : http).request({
    protocol: target.protocol,
    hostname,
    port: target.port || undefined,
    path: target.pathname + target.search,
    method: options.method || 'GET',
    headers,
    agent,
    signal: options.signal
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      agent.destroy();
      reject(error);
    };
    request.once('error', fail);
    request.once('response', incoming => {
      if (settled) { incoming.destroy(); return; }
      settled = true;
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i].toLowerCase();
        const value = incoming.rawHeaders[i + 1];
        if (name === 'set-cookie' && typeof responseHeaders.append === 'function') responseHeaders.append(name, value);
        else responseHeaders.append(name, value);
      }
      incoming.once('close', () => agent.destroy());
      const noBody = options.method === 'HEAD' || incoming.statusCode === 204 || incoming.statusCode === 304;
      const body = noBody ? null : Readable.toWeb(incoming);
      resolve(new Response(body, {
        status: incoming.statusCode || 502,
        statusText: incoming.statusMessage,
        headers: responseHeaders
      }));
    });
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}
