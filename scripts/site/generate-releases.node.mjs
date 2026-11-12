import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeReleaseData, generateReleaseData } from "./generate-releases.mjs";

const release = (tag, published, assets, extra = {}) => ({
  tag_name: tag,
  name: tag,
  published_at: published,
  html_url: "https://github.com/michaelkage/Axiom/releases/tag/" + tag,
  assets,
  ...extra
});
const asset = (name, size = 100) => ({
  name,
  size,
  browser_download_url: "https://github.com/michaelkage/Axiom/releases/download/v1/" + name
});

test("catalog selects the newest stable Windows installer and Android APK independently", () => {
  const data = normalizeReleaseData([
    release("v0.4.13", "2026-10-29T15:00:00Z", [
      asset("Axiom-Setup-0.4.13-x64.exe", 200),
      asset("Axiom-Setup-0.4.13-x64.exe.sha256", 80)
    ]),
    release("android-v1.1.3", "2026-11-11T15:00:00Z", [asset("Axiom-Android-arm64-debug.apk", 300)]),
    release("v0.5.0-rc.1", "2026-11-12T10:00:00Z", [asset("Axiom-Setup-0.5.0-rc.1-x64.exe")], { prerelease: true }),
    release("v9.0.0", "2026-11-13T10:00:00Z", [asset("Axiom-Setup-9.0.0-x64.exe")], { draft: true })
  ], "2026-11-12T00:00:00Z");

  assert.equal(data.windows.version, "0.4.13");
  assert.equal(data.windows.checksum.url.endsWith(".sha256"), true);
  assert.equal(data.android.version, "1.1.3");
  assert.equal(data.android.checksum, null);
  assert.equal(data.generatedAt, "2026-11-12T00:00:00Z");
});

test("catalog ignores releases without the correct repository or platform asset", () => {
  const data = normalizeReleaseData([
    { ...release("v99.0.0", "2026-11-12T00:00:00Z", [asset("Axiom-Setup-99.0.0-x64.exe")]), html_url: "https://github.com/someone/else/releases/tag/v99" },
    release("android-v1.0.0", "2026-11-10T00:00:00Z", [asset("Axiom-Android-arm64-debug.apk")])
  ]);
  assert.equal(data.windows, null);
  assert.equal(data.android.version, "1.0.0");
});

test("generator writes a normalized catalog and sends an optional API token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axiom-release-catalog-"));
  const outputPath = join(directory, "docs", "releases.json");
  let request;
  try {
    const data = await generateReleaseData({
      outputPath,
      token: "test-token",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => [release("v0.4.13", "2026-10-29T15:00:00Z", [asset("Axiom-Setup-0.4.13-x64.exe")])] };
      }
    });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.windows.version, data.windows.version);
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
    assert.match(request.url, /repos\/michaelkage\/Axiom\/releases/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generator fails closed when GitHub API is unavailable or malformed", async () => {
  await assert.rejects(() => generateReleaseData({
    outputPath: join(tmpdir(), "axiom-should-not-exist.json"),
    fetchImpl: async () => ({ ok: false, status: 503 })
  }), /HTTP 503/);
  await assert.rejects(() => generateReleaseData({
    outputPath: join(tmpdir(), "axiom-should-not-exist.json"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: "not a release list" }) })
  }), /unexpected response/);
});
