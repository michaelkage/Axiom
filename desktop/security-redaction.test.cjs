"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { redactSecrets } = require("./security-redaction.cjs");

test("redacts provider credentials and env assignments from desktop diagnostics", () => {
  const source = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\\nAuthorization: Bearer abc.def.ghi\\napi_key=super-secret-value";
  const output = redactSecrets(source);
  assert.doesNotMatch(output, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(output, /abc\\.def\\.ghi/);
  assert.doesNotMatch(output, /super-secret-value/);
});

test("redacts PEM private keys and Supabase-style JWT secrets", () => {
  const source = "-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----";
  assert.doesNotMatch(redactSecrets(source), /private-material/);
  const jwt = "eyJ" + "a".repeat(25) + "." + "b".repeat(15) + "." + "c".repeat(15);
  assert.doesNotMatch(redactSecrets(jwt), /eyJ/);
});
