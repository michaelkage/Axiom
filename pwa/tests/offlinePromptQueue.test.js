import test from "node:test";
import assert from "node:assert/strict";
import { validateOfflinePrompt, MAX_BYTES_PER_ITEM } from "../src/lib/offlinePromptQueue.js";

test("validates and redacts prompt text before offline persistence", () => {
  const item = validateOfflinePrompt({ prompt: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456", attachments: [{ kind: "text", name: "notes.txt", text: "api_key=private-value" }] });
  assert.doesNotMatch(item.prompt, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(item.attachments[0].text, /private-value/);
});

test("rejects invalid prompts and unsupported attachment types", () => {
  assert.throws(() => validateOfflinePrompt({ prompt: " " }), /non-empty prompt/);
  assert.throws(() => validateOfflinePrompt({ prompt: "valid", attachments: [{ kind: "binary", name: "x" }] }), /Invalid offline attachment/);
});

test("enforces the bounded offline item size", () => {
  assert.equal(MAX_BYTES_PER_ITEM, 2 * 1024 * 1024);
  assert.throws(() => validateOfflinePrompt({ prompt: "x", attachments: [{ kind: "image", name: "large.jpg", base64: "x".repeat(MAX_BYTES_PER_ITEM) }] }), /2 MiB/);
});
