"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listMcpCatalog, getMcpCatalogEntry } = require("./mcp-catalog.cjs");

test("catalog contains the requested integrations with unique stable IDs", () => {
  const entries = listMcpCatalog();
  assert.equal(entries.length, 11);
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  for (const id of ["github", "supabase", "playwright", "brave-search", "exa", "crawl4ai", "fetch", "postgresql", "sqlite", "neon", "context7"]) {
    assert.ok(entries.some(entry => entry.id === id), "missing " + id);
  }
});

test("catalog entries disclose source, transport, auth, and risk", () => {
  for (const entry of listMcpCatalog()) {
    assert.match(entry.sourceUrl, /^https:\/\//);
    assert.ok(entry.transport);
    assert.ok(Array.isArray(entry.auth));
    assert.ok(entry.riskLabel);
    assert.equal(entry.state, "unconfigured");
  }
});

test("catalog lookup returns a defensive copy and unknown IDs are rejected", () => {
  const entry = getMcpCatalogEntry("context7");
  assert.equal(entry.endpoint, "https://mcp.context7.com/mcp");
  entry.auth.push("should-not-mutate-catalog");
  assert.equal(getMcpCatalogEntry("context7").auth.includes("should-not-mutate-catalog"), false);
  assert.equal(getMcpCatalogEntry("made-up-server"), null);
});
