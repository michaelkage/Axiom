import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactValue, redactForExternalContext } from "../src/lib/securityRedaction.js";

test("redacts provider tokens, env assignments, authorization headers and private keys", () => {
  const input = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\nAuthorization: Bearer abc.def.ghi\napi_key=super-secret-value\ngh p";
  const output = redactSecrets(input);
  assert.doesNotMatch(output, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(output, /abc\.def\.ghi/);
  assert.doesNotMatch(output, /super-secret-value/);
  assert.match(output, /GITHUB_TOKEN=\[REDACTED\]/);
});

test("redacts sensitive object fields recursively", () => {
  const value = redactValue({ token: "abc", nested: { password: "secret", message: "api_key=hidden" } });
  assert.equal(value.token, "[REDACTED]");
  assert.equal(value.nested.password, "[REDACTED]");
  assert.doesNotMatch(value.nested.message, /hidden/);
});

test("redacts model context without mutating original messages", () => {
  const source = [{ role: "user", content: "token=private-value" }];
  const result = redactForExternalContext(source);
  assert.doesNotMatch(result[0].content, /private-value/);
  assert.match(source[0].content, /private-value/);
});
