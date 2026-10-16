"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBaseUrl, isLoopback } = require("./omniroute.cjs");

test("normalizes API base URLs and rejects embedded credentials", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:20128/v1/"), "http://127.0.0.1:20128/v1");
  assert.throws(() => normalizeBaseUrl("http://user:secret@localhost/v1"), /cannot contain credentials/);
  assert.throws(() => normalizeBaseUrl("file:///tmp/api"), /HTTP/);
});

test("recognizes loopback router endpoints without treating remote hosts as local", () => {
  assert.equal(isLoopback("http://localhost:20128/v1"), true);
  assert.equal(isLoopback("http://127.0.0.1:20128/v1"), true);
  assert.equal(isLoopback("https://api.example.com/v1"), false);
});
