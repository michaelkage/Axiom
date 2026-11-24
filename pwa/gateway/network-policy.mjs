import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

export async function assertSafeMcpTarget(value, allowedPrivateHosts = new Set()) {
  const target = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('MCP endpoint must be HTTP(S) without embedded credentials.');
  }
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (allowedPrivateHosts.has(hostname)) return target;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('MCP endpoint resolves to a local hostname; add its exact hostname to AXIOM_MCP_ALLOWED_PRIVATE_HOSTS only if intentionally trusted.');
  }
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new Error('MCP endpoint resolves to a private, reserved, or non-public network address.');
  }
  return target;
}
