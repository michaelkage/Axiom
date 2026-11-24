"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBrowserNavigation } = require("./browser-url.cjs");

test("accepts HTTP and HTTPS URLs and normalizes whitespace", () => {
  assert.equal(validateBrowserNavigation(" https://example.com/app "), "https://example.com/app");
  assert.equal(validateBrowserNavigation("http://localhost:3000"), "http://localhost:3000/");
});

test("rejects unsafe protocols, relative URLs and embedded credentials", () => {
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "example.com", "https://user:pass@example.com"]) {
    assert.throws(() => validateBrowserNavigation(value));
  }
});

test("rejects empty and oversized navigation requests", () => {
  assert.throws(() => validateBrowserNavigation("  "), /valid HTTP or HTTPS URL/i);
  assert.throws(() => validateBrowserNavigation("https://example.com/" + "a".repeat(4100)), /valid HTTP or HTTPS URL/i);
});
