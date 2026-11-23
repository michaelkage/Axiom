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
    return /^2[0-9a-f]{3}:/.test(normalized) && !normalized.startsWith("2001:db8:");
  }
  return false;
}

function createNetworkPolicyProxy({ authorize, host = "127.0.0.1", port = 0, token = crypto.randomBytes(32).toString("hex"), resolveHost = dns.lookup, allowPrivateAddresses = false } = {}) {
  if (typeof authorize !== "function") throw new TypeError("Network proxy requires a policy authorizer.");
  if (typeof resolveHost !== "function" || typeof allowPrivateAddresses !== "boolean") throw new TypeError("Invalid proxy DNS policy.");
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Network proxy must bind to loopback and a valid port.");
  if (typeof token !== "string" || token.length < 32) throw new TypeError("Network proxy requires a high-entropy authentication token.");

  const sockets = new Set();
  let server = null;
  let proxyUrl = null;
  let stopped = false;
  const authCredential = Buffer.from("axiom:" + token);
  const authValue = authCredential.toString("base64");

  function authorizedProxyRequest(request) {
    const header = request.headers["proxy-authorization"];
    if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
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

  async function handleConnect(request, clientSocket, head) {
    if (!authorizedProxyRequest(request)) {
      writeError(clientSocket, "407 Proxy Authentication Required", "Axiom network proxy authentication failed.");
      return;
    }
    let target;
    try {
      const parsed = new URL("http://" + request.url);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
      const targetPort = Number(parsed.port || 443);
      if (!hostname || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error();
      target = { hostname, port: targetPort, url: "https://" + (hostname.includes(":") ? "[" + hostname + "]" : hostname) + ":" + targetPort + "/" };
    } catch {
      writeError(clientSocket, "400 Bad Request", "Invalid CONNECT destination.");
      return;
    }
    let resolved;
    try { await authorizeUrl(target.url); resolved = await resolvePublicHost(target.hostname); }
    catch {
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
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Axiom\r\n\r\n");
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
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
    try {
      target = await authorizeUrl(request.url);
      if (target.protocol !== "http:") throw new Error("HTTPS requests must use CONNECT.");
      var resolved = await resolvePublicHost(target.hostname);
    } catch {
      response.writeHead(403, { "content-type": "text/plain", connection: "close" });
      response.end("Outbound request denied by Axiom workspace security policy.");
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(target, {
      method: request.method,
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

module.exports = { createNetworkPolicyProxy, isPublicAddress, SOCKET_TIMEOUT_MS, MAX_HEADER_BYTES };
