"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createNetworkPolicyProxy, isPublicAddress } = require("./network-policy-proxy.cjs");

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
