"use strict";

const DEFAULT_MAX_BYTES = 1024 * 1024;

function createRuntimeOutputCapture(options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new TypeError("Runtime output capture limit must be between 1 byte and 16 MiB.");
  }
  const maxChunks = options.maxChunks ?? 8192;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 65536) throw new TypeError("Runtime output chunk limit must be between 1 and 65536.");
  const chunks = [];
  const streamBytes = { stdout: 0, stderr: 0 };
  let bytes = 0;
  let truncated = false;

  function append(stream, chunk) {
    if (stream !== "stdout" && stream !== "stderr") throw new TypeError("Runtime output stream must be stdout or stderr.");
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (value.length === 0) return 0;
    const available = maxBytes - bytes;
    if (available <= 0 || chunks.length >= maxChunks) {
      truncated = true;
      return 0;
    }
    const accepted = value.subarray(0, Math.min(available, maxBytes));
    chunks.push({ stream, data: Buffer.from(accepted) });
    bytes += accepted.length;
    streamBytes[stream] += accepted.length;
    if (accepted.length < value.length) truncated = true;
    return accepted.length;
  }

  function snapshot() {
    return Object.freeze({
      data: Buffer.concat(chunks.map(item => Buffer.concat([Buffer.from("[" + item.stream.toUpperCase() + "] "), item.data]))).toString("utf8"),
      bytes,
      truncated,
      stdoutBytes: streamBytes.stdout,
      stderrBytes: streamBytes.stderr
    });
  }

  return Object.freeze({ append, snapshot });
}

module.exports = { createRuntimeOutputCapture, DEFAULT_MAX_BYTES };
