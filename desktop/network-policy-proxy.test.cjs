"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const { createNetworkPolicyProxy, isPublicAddress, extractTlsServerName } = require("./network-policy-proxy.cjs");

function readHeaders(socket) {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("Proxy response timed out.")), 3000);
    socket.on("data", chunk => {
      data += chunk.toString("latin1");
      const end = data.indexOf("\r\n\r\n");
      if (end !== -1) {
        clearTimeout(timer);
        resolve(data.slice(0, end));
      }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

async function connectProxy(proxyUrl, target, includeAuth = true) {
  const parsed = new URL(proxyUrl);
  const socket = net.connect(Number(parsed.port), parsed.hostname);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const auth = includeAuth
    ? "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(parsed.username) + ":" + decodeURIComponent(parsed.password)).toString("base64") + "\r\n"
    : "";
  socket.write("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n" + auth + "Connection: keep-alive\r\n\r\n");
  const response = await readHeaders(socket);
  socket.destroy();
  return response;
}

test("network proxy requires per-runtime proxy authentication", async () => {
  const proxy = createNetworkPolicyProxy({ authorize: async () => true });
  try {
    const environment = await proxy.start();
    const response = await connectProxy(environment.HTTPS_PROXY, "127.0.0.1:443", false);
    assert.match(response, /^HTTP\/1\.1 407/);
  } finally { await proxy.stop(); }
});

test("network proxy gates CONNECT destinations through the supplied workspace authorizer", async () => {
  const upstream = net.createServer(() => {});
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const seen = [];
  const proxy = createNetworkPolicyProxy({
    allowPrivateAddresses: true,
    authorize: async request => {
      seen.push(request);
      return request.hostname === "127.0.0.1";
    }
  });
  try {
    const environment = await proxy.start();
    const allowed = await connectProxy(environment.HTTPS_PROXY, "127.0.0.1:" + upstreamPort);
    assert.match(allowed, /^HTTP\/1\.1 200/);
    assert.equal(seen[0].hostname, "127.0.0.1");
    assert.equal(seen[0].port, upstreamPort);
    const denied = await connectProxy(environment.HTTPS_PROXY, "example.invalid:443");
    assert.match(denied, /^HTTP\/1\.1 403/);
  } finally {
    await proxy.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("network proxy environment bypasses only explicit loopback destinations", async () => {
  const proxy = createNetworkPolicyProxy({ authorize: async () => true });
  try {
    const environment = await proxy.start();
    assert.equal(environment.HTTP_PROXY, environment.HTTPS_PROXY);
    assert.equal(environment.ALL_PROXY, environment.HTTPS_PROXY);
    assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(environment.NODE_USE_ENV_PROXY, "1");
    assert.match(environment.HTTPS_PROXY, /^http:\/\/axiom:[a-f0-9]{64}@127\.0\.0\.1:/);
  } finally { await proxy.stop(); }
});

test("network proxy rejects private, loopback, link-local and reserved DNS results by default", () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("network proxy forwards authenticated HTTP through pinned DNS results", async () => {
  const upstream = http.createServer((_request, response) => response.end("policy-proxy-ok"));
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = createNetworkPolicyProxy({
    allowPrivateAddresses: true,
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    authorize: async request => request.hostname === "example.invalid" && request.protocol === "http:"
  });
  try {
    const environment = await proxy.start();
    const proxyUrl = new URL(environment.HTTP_PROXY);
    const authorization = "Basic " + Buffer.from(decodeURIComponent(proxyUrl.username) + ":" + decodeURIComponent(proxyUrl.password)).toString("base64");
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: Number(proxyUrl.port),
        path: "http://example.invalid:" + upstreamPort + "/resource",
        method: "GET",
        headers: { Host: "example.invalid:" + upstreamPort, "Proxy-Authorization": authorization }
      }, result => {
        let body = "";
        result.setEncoding("utf8");
        result.on("data", chunk => { body += chunk; });
        result.on("end", () => resolve({ status: result.statusCode, body }));
      });
      request.once("error", reject);
      request.end();
    });
    assert.deepEqual(response, { status: 200, body: "policy-proxy-ok" });
  } finally {
    await proxy.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

function makeClientHello(hostname) {
  let extensions = Buffer.alloc(0);
  if (hostname) {
    const name = Buffer.from(hostname, "ascii");
    const nameEntry = Buffer.concat([Buffer.from([0, (name.length >> 8) & 255, name.length & 255]), name]);
    const nameList = Buffer.concat([Buffer.from([(nameEntry.length >> 8) & 255, nameEntry.length & 255]), nameEntry]);
    extensions = Buffer.concat([Buffer.from([0, 0, (nameList.length >> 8) & 255, nameList.length & 255]), nameList]);
  }
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    Buffer.from([(extensions.length >> 8) & 255, extensions.length & 255]),
    extensions
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 1;
  handshake.writeUIntBE(body.length, 1, 3);
  const message = Buffer.concat([handshake, body]);
  const record = Buffer.from([0x16, 0x03, 0x01, (message.length >> 8) & 255, message.length & 255]);
  return Buffer.concat([record, message]);
}

test("TLS ClientHello inspection extracts and validates SNI before a CONNECT tunnel opens", () => {
  const hello = makeClientHello("api.example.com");
  assert.deepEqual(extractTlsServerName(hello), { status: "complete", hostname: "api.example.com" });
  assert.equal(extractTlsServerName(hello.subarray(0, 8)).status, "need-more");
  const noSni = extractTlsServerName(makeClientHello());
  assert.equal(noSni.status, "invalid");
  assert.match(noSni.reason, /no server-name extension/);
});
