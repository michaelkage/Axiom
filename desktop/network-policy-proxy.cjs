"use strict";

const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns").promises;
const crypto = require("node:crypto");

const SOCKET_TIMEOUT_MS = 120000;
const MAX_HEADER_BYTES = 16 * 1024;

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith("2001:db8:");
  }
  return false;
}

function extractTlsServerName(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("TLS handshake data must be a Buffer.");
  const invalid = reason => ({ status: "invalid", reason });
  if (buffer.length < 5) return { status: "need-more" };
  if (buffer[0] !== 0x16 || buffer[1] !== 0x03) return invalid("CONNECT tunnel did not begin with a TLS handshake.");
  const recordLength = buffer.readUInt16BE(3);
  if (recordLength < 4) return invalid("TLS record length is invalid.");
  if (buffer.length < 5 + recordLength) return { status: "need-more" };
  const record = buffer.subarray(5, 5 + recordLength);
  if (record[0] !== 0x01) return invalid("TLS record does not contain a ClientHello.");
  const handshakeLength = record.readUIntBE(1, 3);
  if (handshakeLength < 38 || handshakeLength !== record.length - 4) {
    return invalid("Fragmented or malformed TLS ClientHello is not accepted.");
  }
  const body = record.subarray(4);
  let offset = 34;
  if (offset >= body.length) return invalid("TLS ClientHello is truncated.");
  const sessionLength = body[offset++];
  if (offset + sessionLength + 2 > body.length) return invalid("TLS session or cipher-suite list is truncated.");
  offset += sessionLength;
  const cipherLength = body.readUInt16BE(offset);
  offset += 2;
  if (cipherLength < 2 || cipherLength % 2 !== 0 || offset + cipherLength + 1 > body.length) {
    return invalid("TLS cipher-suite list is invalid.");
  }
  offset += cipherLength;
  const compressionLength = body[offset++];
  if (compressionLength < 1 || offset + compressionLength + 2 > body.length) return invalid("TLS compression list is invalid.");
  offset += compressionLength;
  const extensionsLength = body.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd !== body.length) return invalid("TLS extension list does not match ClientHello bounds.");
  while (offset < extensionsEnd) {
    if (offset + 4 > extensionsEnd) return invalid("TLS extension header is truncated.");
    const extensionType = body.readUInt16BE(offset);
    const extensionLength = body.readUInt16BE(offset + 2);
    offset += 4;
    const extensionEnd = offset + extensionLength;
    if (extensionEnd > extensionsEnd) return invalid("TLS extension length is invalid.");
    if (extensionType === 0xfe0d) return invalid("Encrypted ClientHello is not supported by hostname policy enforcement.");
    if (extensionType === 0x0000) {
      if (offset + 2 > extensionEnd) return invalid("TLS server-name extension is truncated.");
      const listLength = body.readUInt16BE(offset);
      let nameOffset = offset + 2;
      const listEnd = nameOffset + listLength;
      if (listEnd !== extensionEnd) return invalid("TLS server-name list is invalid.");
      while (nameOffset < listEnd) {
        if (nameOffset + 3 > listEnd) return invalid("TLS server-name entry is truncated.");
        const nameType = body[nameOffset++];
        const nameLength = body.readUInt16BE(nameOffset);
        nameOffset += 2;
        if (nameLength < 1 || nameOffset + nameLength > listEnd) return invalid("TLS server-name value is invalid.");
        const name = body.subarray(nameOffset, nameOffset + nameLength).toString("ascii").toLowerCase().replace(/\.$/, "");
        if (nameType === 0) {
          if (!name || name.length > 253 || !/^[a-z0-9.-]+$/.test(name) || name.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
            return invalid("TLS server name is not a valid DNS hostname.");
          }
          return { status: "complete", hostname: name };
        }
        nameOffset += nameLength;
      }
      return invalid("TLS ClientHello did not include a DNS server name.");
    }
    offset = extensionEnd;
  }
  return invalid("TLS ClientHello has no server-name extension.");
}

function createNetworkPolicyProxy({ authorize, onBlocked = () => {}, host = "127.0.0.1", port = 0, token = crypto.randomBytes(32).toString("hex"), resolveHost = dns.lookup, allowPrivateAddresses = false } = {}) {
  if (typeof authorize !== "function" || typeof onBlocked !== "function") throw new TypeError("Network proxy requires policy authorization and audit callbacks.");
  if (typeof resolveHost !== "function" || typeof allowPrivateAddresses !== "boolean") throw new TypeError("Invalid proxy DNS policy.");
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Network proxy must bind to loopback and a valid port.");
  if (typeof token !== "string" || token.length < 32) throw new TypeError("Network proxy requires a high-entropy authentication token.");

  const sockets = new Set();
  let server = null;
  let proxyUrl = null;
  let stopped = false;
  const authCredential = Buffer.from("axiom:" + token);

  function authorizedProxyRequest(request) {
    const header = request.headers["proxy-authorization"];
    if (typeof header !== "string" || !header.startsWith("Basic ") || !/^[A-Za-z0-9+/]+=*$/.test(header.slice(6))) return false;
    const supplied = Buffer.from(header.slice(6), "base64");
    const expected = authCredential;
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function writeError(socket, status, message) {
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: " + Buffer.byteLength(message) + "\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + message);
    }
  }

  async function resolvePublicHost(hostname) {
    const addresses = await resolveHost(hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("Network destination did not resolve.");
    if (!allowPrivateAddresses && addresses.some(item => !isPublicAddress(item.address))) {
      throw new Error("Network destination resolves to a private, reserved or non-global address.");
    }
    return addresses[0];
  }

  async function authorizeUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("Invalid proxy destination."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
      throw new Error("Proxy destination must be a credential-free HTTP(S) URL.");
    }
    const result = await authorize({
      url: parsed.toString(),
      hostname: parsed.hostname.toLowerCase(),
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      protocol: parsed.protocol
    });
    if (result !== true) throw new Error("Workspace network policy denied this destination.");
    return parsed;
  }

  async function reportBlocked(url, error) {
    try { await onBlocked({ url, reason: String(error?.message || error || "Network request denied.").slice(0, 400) }); }
    catch { /* A failed audit callback never permits the blocked connection. */ }
  }

  async function handleConnect(request, clientSocket, head) {
    if (!authorizedProxyRequest(request)) {
      writeError(clientSocket, "407 Proxy Authentication Required", "Axiom network proxy authentication failed.");
      return;
    }
    let target;
    try {
      if (typeof request.url !== "string" || !request.url || /[\s/?#@]/.test(request.url.split("]")[1] || "")) throw new Error();
      const parsed = new URL("http://" + request.url);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
      const targetPort = Number(parsed.port || 443);
      if (!hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
          !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error();
      target = { hostname, port: targetPort, url: "https://" + (hostname.includes(":") ? "[" + hostname + "]" : hostname) + ":" + targetPort + "/" };
    } catch {
      writeError(clientSocket, "400 Bad Request", "Invalid CONNECT destination.");
      return;
    }
    let resolved;
    try { await authorizeUrl(target.url); resolved = await resolvePublicHost(target.hostname); }
    catch (error) {
      await reportBlocked(target.url, error);
      writeError(clientSocket, "403 Forbidden", "Outbound connection denied by Axiom workspace security policy.");
      return;
    }
    const upstream = net.connect({ host: resolved.address, family: resolved.family, port: target.port });
    let established = false;
    sockets.add(upstream);
    upstream.setTimeout(SOCKET_TIMEOUT_MS, () => upstream.destroy(new Error("Proxy upstream timed out.")));
    upstream.once("error", () => {
      if (!clientSocket.destroyed && !established) writeError(clientSocket, "502 Bad Gateway", "Axiom could not connect to the approved destination.");
      clientSocket.destroy();
    });
    upstream.once("connect", () => {
      if (clientSocket.destroyed) { upstream.destroy(); return; }
      established = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Axiom\r\n\r\n");
      let clientHello = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const handshakeTimer = setTimeout(() => {
        void reportBlocked(target.url, new Error("TLS ClientHello timed out."));
        clientSocket.destroy();
        upstream.destroy();
      }, 10000);
      const onClientData = chunk => {
        clientHello = Buffer.concat([clientHello, chunk]);
        if (clientHello.length > 65536) {
          clearTimeout(handshakeTimer);
          void reportBlocked(target.url, new Error("TLS ClientHello exceeded the inspection limit."));
          clientSocket.destroy();
          upstream.destroy();
          return;
        }
        const parsed = extractTlsServerName(clientHello);
        if (parsed.status === "need-more") return;
        clearTimeout(handshakeTimer);
        if (parsed.status !== "complete" || parsed.hostname !== target.hostname.toLowerCase().replace(/\.$/, "")) {
          void reportBlocked(target.url, new Error(parsed.reason || "TLS SNI does not match the authorized CONNECT hostname."));
          clientSocket.destroy();
          upstream.destroy();
          return;
        }
        clientSocket.off("data", onClientData);
        upstream.write(clientHello);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      };
      clientSocket.on("data", onClientData);
      clientSocket.once("close", () => { clearTimeout(handshakeTimer); upstream.destroy(); });
      if (clientHello.length) onClientData(Buffer.alloc(0));
    });
    upstream.once("close", () => sockets.delete(upstream));
  }

  async function handleHttp(request, response) {
    if (!authorizedProxyRequest(request)) {
      response.writeHead(407, { "content-type": "text/plain", connection: "close" });
      response.end("Axiom network proxy authentication failed.");
      return;
    }
    let target;
    let resolved;
    try {
      target = await authorizeUrl(request.url);
      if (target.protocol !== "http:") throw new Error("HTTPS requests must use CONNECT.");
      resolved = await resolvePublicHost(target.hostname);
    } catch (error) {
      await reportBlocked(request.url, error);
      response.writeHead(403, { "content-type": "text/plain", connection: "close" });
      response.end("Outbound request denied by Axiom workspace security policy.");
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    headers.host = target.host;
    headers.connection = "close";
    const upstream = http.request(target, {
      method: request.method,
      agent: false,
      headers,
      timeout: SOCKET_TIMEOUT_MS,
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family)
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Proxy request timed out.")));
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("Axiom could not complete the approved HTTP request.");
    });
    request.pipe(upstream);
  }

  async function start() {
    if (server) return environment();
    if (stopped) throw new Error("Axiom network proxy has already been stopped.");
    server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => { void handleHttp(request, response); });
    server.maxHeadersCount = 64;
    server.maxConnections = 128;
    server.headersTimeout = 15000;
    server.requestTimeout = SOCKET_TIMEOUT_MS;
    server.on("connection", socket => {
      sockets.add(socket);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("connect", (request, socket, head) => { void handleConnect(request, socket, head); });
    server.on("clientError", (_error, socket) => writeError(socket, "400 Bad Request", "Malformed proxy request."));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Axiom network proxy did not bind to a TCP port.");
    proxyUrl = "http://axiom:" + token + "@" + host + ":" + address.port;
    return environment();
  }

  function environment() {
    if (!proxyUrl) throw new Error("Axiom network proxy has not started.");
    return {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1"
    };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) {
      const current = server;
      server = null;
      await new Promise(resolve => current.close(() => resolve()));
    }
    proxyUrl = null;
  }

  return Object.freeze({ start, environment, stop, get running() { return !!server && !stopped; } });
}

module.exports = { createNetworkPolicyProxy, isPublicAddress, extractTlsServerName, SOCKET_TIMEOUT_MS, MAX_HEADER_BYTES };
