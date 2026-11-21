"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDeploymentManager, resolveBuildOutput, extractPreviewUrl, deploymentCommand } = require("./deployment-provider.cjs");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-deploy-"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.html"), "<h1>preview</h1>");
  return root;
}

test("deployment accepts only non-empty build output inside the project", async () => {
  const root = await fixture();
  try {
    const result = await resolveBuildOutput(root, "dist");
    assert.equal(result.output, path.join(root, "dist"));
    await assert.rejects(resolveBuildOutput(root, "../outside"), /child directory/i);
    await fs.rm(path.join(root, "dist", "index.html"));
    await assert.rejects(resolveBuildOutput(root, "dist"), /empty/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("vercel preview deployment uses a credential environment variable and returns URL metadata", async () => {
  const root = await fixture();
  let invocation;
  try {
    const manager = createDeploymentManager({
      getCredential: async provider => provider === "vercel" ? "vercel-secret-token" : null,
      execFile: async (binary, args, options) => {
        invocation = { binary, args, options };
        return { stdout: "Preview: https://axiom-preview.vercel.app", stderr: "" };
      },
    });
    const result = await manager.deployPreview({ provider: "vercel", projectRoot: root, outputDirectory: "dist" });
    assert.equal(result.status, "deployed");
    assert.equal(result.target, "preview");
    assert.equal(result.previewUrl, "https://axiom-preview.vercel.app");
    assert.equal(invocation.options.env.VERCEL_TOKEN, "vercel-secret-token");
    assert.ok(!invocation.args.join(" ").includes("vercel-secret-token"));
    assert.equal(invocation.options.cwd, root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("netlify requires a site ID and extracts JSON deploy URLs", () => {
  assert.throws(() => deploymentCommand("netlify", { output: "/tmp/dist" }), /site ID/i);
  assert.equal(extractPreviewUrl("netlify", '{"deploy_url":"https://axiom-preview.netlify.app"}'), "https://axiom-preview.netlify.app");
});

test("cloudflare Pages preview uses a non-production branch and account ID", async () => {
  const root = await fixture();
  let invocation;
  try {
    const manager = createDeploymentManager({
      getCredential: async () => "cloudflare-secret",
      execFile: async (binary, args, options) => {
        invocation = { binary, args, options };
        return { stdout: "https://axiom-preview.pages.dev", stderr: "" };
      },
    });
    const result = await manager.deployPreview({
      provider: "cloudflare-pages", projectRoot: root, outputDirectory: "dist",
      projectName: "axiom", accountId: "0123456789abcdef0123456789abcdef",
    });
    assert.equal(result.previewUrl, "https://axiom-preview.pages.dev");
    assert.ok(invocation.args.some(value => /^axiom-preview-[a-z0-9]+$/.test(value)));
    assert.equal(invocation.options.env.CLOUDFLARE_ACCOUNT_ID, "account-123");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("production deployments are rejected by the preview adapter", async () => {
  const root = await fixture();
  try {
    const manager = createDeploymentManager({ getCredential: async () => "vercel-secret" });
    await assert.rejects(manager.deployPreview({
      provider: "vercel", target: "production", projectRoot: root, outputDirectory: "dist",
    }), /only supports preview/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("provider output URLs must be HTTPS and match the selected provider", () => {
  assert.equal(extractPreviewUrl("vercel", "https://evil.example.com"), null);
  assert.equal(extractPreviewUrl("vercel", "https://axiom.vercel.app"), "https://axiom.vercel.app");
});
