"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeOutputCapture, DEFAULT_MAX_BYTES } = require("./runtime-output-capture.cjs");

test("captures stdout and stderr in arrival order with stream labels", () => {
  const capture = createRuntimeOutputCapture();
  capture.append("stdout", "runtime ready\n");
  capture.append("stderr", Buffer.from("warning\n"));
  const result = capture.snapshot();
  assert.equal(result.data, "[STDOUT] runtime ready\n[STDERR] warning\n");
  assert.equal(result.stdoutBytes, 14);
  assert.equal(result.stderrBytes, 8);
  assert.equal(result.bytes, 22);
  assert.equal(result.truncated, false);
});

test("caps retained output and reports truncation without growing memory", () => {
  const capture = createRuntimeOutputCapture({ maxBytes: 8 });
  assert.equal(capture.append("stdout", "123456"), 6);
  assert.equal(capture.append("stderr", "abcdef"), 2);
  assert.equal(capture.append("stdout", "overflow"), 0);
  const result = capture.snapshot();
  assert.equal(result.bytes, 8);
  assert.equal(result.stdoutBytes, 6);
  assert.equal(result.stderrBytes, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.data, "[STDOUT] 123456[STDERR] ab");
});

test("validates configured limits and stream names", () => {
  assert.throws(() => createRuntimeOutputCapture({ maxBytes: 0 }), /limit/);
  assert.throws(() => createRuntimeOutputCapture({ maxBytes: DEFAULT_MAX_BYTES + 1, }), /limit/);
  const capture = createRuntimeOutputCapture();
  assert.throws(() => capture.append("stdin", "not captured"), /stream/);
});
