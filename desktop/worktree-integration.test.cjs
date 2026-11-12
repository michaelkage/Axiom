"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeWorkspaceRelativePath, resolveSafeWorkspaceFile, withWorkspaceIntegrationLock } = require("./worktree-integration.cjs");

test("normalizes safe workspace-relative paths and rejects traversal or ambiguous paths", () => {
  assert.equal(normalizeWorkspaceRelativePath("src\\feature.ts"), "src/feature.ts");
  for (const value of ["", "../outside", "src/../outside", "/etc/passwd", "C:/Windows/file", "src//file", "src/./file", " src/file", "src/file ", "src\\..\\outside", "src/file:name", "src/\0file"]) {
    assert.throws(() => normalizeWorkspaceRelativePath(value), /Invalid workspace-relative|normalized, relative/);
  }
});

test("rejects symlinks in parent and leaf components while allowing missing files", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worktree-path-"));
  try {
    const root = path.join(temporary, "repo");
    const outside = path.join(temporary, "outside");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.writeFile(path.join(root, "src", "safe.ts"), "safe");
    assert.equal(await resolveSafeWorkspaceFile(root, "src/safe.ts"), path.join(root, "src", "safe.ts"));
    assert.equal(await resolveSafeWorkspaceFile(root, "src/new.ts"), path.join(root, "src", "new.ts"));
    await fs.symlink(outside, path.join(root, "linked"), "junction");
    await assert.rejects(() => resolveSafeWorkspaceFile(root, "linked/secret.txt"), /symbolic links/);
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link.ts"));
    await assert.rejects(() => resolveSafeWorkspaceFile(root, "secret-link.ts"), /symbolic links/);
    await assert.rejects(() => resolveSafeWorkspaceFile(root, "src/safe.ts/child"), /not a directory/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("serializes integration operations per workspace without blocking other workspaces", async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const first = withWorkspaceIntegrationLock("/tmp/axiom-lock-a", async () => { order.push("first-start"); await gate; order.push("first-end"); });
  const second = withWorkspaceIntegrationLock("/tmp/axiom-lock-a", async () => { order.push("second"); });
  const independent = withWorkspaceIntegrationLock("/tmp/axiom-lock-b", async () => { order.push("independent"); });
  await independent;
  await Promise.resolve();
  assert.deepEqual(order, ["first-start", "independent"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "independent", "first-end", "second"]);
});
