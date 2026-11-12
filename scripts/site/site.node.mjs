import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../../docs/index.html", import.meta.url), "utf8");

test("product page exposes accurate platform, safety and documentation information", () => {
  assert.match(html, /Windows x64/);
  assert.match(html, /Debug-signed sideload build/);
  assert.match(html, /No VS Code installation or extension host required/);
  assert.match(html, /Review before integration/);
  assert.match(html, /DESKTOP_TROUBLESHOOTING\.md/);
  assert.match(html, /QUICKSTART\.md/);
  assert.match(html, /releases\.json/);
  assert.match(html, /SHA-256 checksum/);
});

test("inline browser JavaScript parses and release links use the generated catalog", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  assert.match(scripts[0][1], /schemaVersion !== 1/);
  assert.match(scripts[0][1], /releaseFallback/);
  assert.match(scripts[0][1], /noopener noreferrer/);
});

test("page has responsive layout and no third-party runtime dependency", () => {
  assert.match(html, /@media\(max-width:560px\)/);
  assert.match(html, /@media\(max-width:820px\)/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet[^>]+href="https?:/i);
});
