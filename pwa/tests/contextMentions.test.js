import test from "node:test";
import assert from "node:assert/strict";
import { parseContextMentions, buildContextMentionPrompt } from "../src/lib/contextMentions.js";

test("parses explicit file, folder, diff and memory context mentions", () => {
  const mentions = parseContextMentions("Inspect @file:src/App.jsx and @folder:pwa/src plus @git-diff @memory");
  assert.deepEqual(mentions.map(item => item.kind), ["file", "folder", "git-diff", "memory"]);
  assert.equal(mentions[0].target, "src/App.jsx");
  assert.equal(mentions[1].target, "pwa/src");
});

test("ignores malformed and overlong path mentions", () => {
  assert.deepEqual(parseContextMentions("@file @folder:" + "a".repeat(250)), []);
});

test("builds bounded explicit context sections", () => {
  const mentions = parseContextMentions("@file:src/App.jsx");
  const prompt = buildContextMentionPrompt(mentions, [{ content: "const value = 1;" }]);
  assert.match(prompt, /PINNED FILE: src\/App\.jsx/);
  assert.match(prompt, /const value = 1/);
});
