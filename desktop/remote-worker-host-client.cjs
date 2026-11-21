"use strict";

function validateRemoteWorkerConfig(input) {
  if (!input || typeof input !== "object") throw new TypeError("Remote Worker Host settings are required.");
  let host;
  try { host = new URL(String(input.hostUrl || "").trim()); }
  catch { throw new TypeError("Enter a valid Worker Host URL."); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host.hostname.replace(/^\[|\]$/g, ""));
  if (!["https:", "http:"].includes(host.protocol) || (host.protocol !== "https:" && !loopback)
    || host.username || host.password || host.search || host.hash || (host.pathname !== "/" && host.pathname !== "")) {
    throw new Error("Worker Host must use HTTPS; plain HTTP is allowed only for localhost.");
  }
  let repository;
  try { repository = new URL(String(input.repositoryUrl || "").trim()); }
  catch { throw new TypeError("Enter a valid HTTPS Git repository URL."); }
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.search || repository.hash) {
    throw new Error("Remote repository URL must use HTTPS and must not embed credentials.");
  }
  const token = String(input.token || "");
  if (token.length < 32 || token.length > 4096 || /[\0\r\n]/.test(token)) {
    throw new TypeError("Worker Host bearer token must contain 32–4096 characters on one line.");
  }
  const branch = String(input.branch || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new TypeError("Enter a valid Git branch name.");
  }
  return { hostUrl: host.origin, repositoryUrl: repository.href, branch, token };
}

function createRemoteWorkerHostClient(options = {}) {
  if (typeof options.getConfig !== "function" || typeof options.getToken !== "function") {
    throw new TypeError("Remote Worker Host client requires secure configuration and token providers.");
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable in this runtime.");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1000), 120000) : 30000;
  async function request(method, route, body) {
    const [config, token] = await Promise.all([options.getConfig(), options.getToken()]);
    if (!config?.hostUrl || typeof token !== "string" || token.length < 32) {
      throw new Error("Remote Worker Host is not configured. Save its URL and bearer token in Axiom settings.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL("/v1" + route, config.hostUrl), {
        method, redirect: "error", signal: controller.signal,
        headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let payload;
      try { payload = await response.json(); } catch { payload = {}; }
      if (!response.ok) throw new Error("Remote Worker Host returned HTTP " + response.status + ": " + String(payload.error || response.statusText || "request failed").slice(0, 500));
      return payload;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Remote Worker Host request timed out after " + timeoutMs + "ms.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    submit: input => request("POST", "/jobs", input),
    get: id => request("GET", "/jobs/" + encodeURIComponent(id)),
    getPatch: id => request("GET", "/jobs/" + encodeURIComponent(id) + "/patch"),
    cancel: id => request("POST", "/jobs/" + encodeURIComponent(id) + "/cancel", {}),
  });
}
module.exports = { validateRemoteWorkerConfig, createRemoteWorkerHostClient };
