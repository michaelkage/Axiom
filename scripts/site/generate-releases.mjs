#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_URL = "https://api.github.com/repos/michaelkage/Axiom/releases?per_page=100";

function validAsset(asset) {
  return typeof asset?.name === "string"
    && typeof asset?.browser_download_url === "string"
    && asset.browser_download_url.startsWith("https://github.com/michaelkage/Axiom/releases/download/")
    && Number.isFinite(asset.size);
}

function releaseRecord(release, kind) {
  const assets = (release.assets || []).filter(validAsset);
  const installer = assets.find(asset => /^Axiom-Setup-.*-x64\.exe$/i.test(asset.name));
  const apk = assets.find(asset => /^Axiom-Android-arm64-debug\.apk$/i.test(asset.name));
  const selected = kind === "windows" ? installer : apk;
  if (!selected) return null;
  const checksum = assets.find(asset => asset.name === selected.name + ".sha256");
  return {
    version: String(release.tag_name || "").replace(/^(v|android-v)/, ""),
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at || null,
    releaseUrl: release.html_url,
    asset: { name: selected.name, url: selected.browser_download_url, size: selected.size },
    checksum: checksum ? { name: checksum.name, url: checksum.browser_download_url } : null,
    notes: typeof release.body === "string" ? release.body.slice(0, 12000) : ""
  };
}

export function normalizeReleaseData(releases, generatedAt = new Date().toISOString()) {
  const stable = releases
    .filter(item => item && !item.draft && !item.prerelease && item.html_url?.startsWith("https://github.com/michaelkage/Axiom/releases/"))
    .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
  const latest = kind => {
    for (const release of stable) {
      const record = releaseRecord(release, kind);
      if (record) return record;
    }
    return null;
  };
  return {
    schemaVersion: 1,
    generatedAt,
    repository: "https://github.com/michaelkage/Axiom",
    releasesUrl: "https://github.com/michaelkage/Axiom/releases",
    windows: latest("windows"),
    android: latest("android")
  };
}

export async function generateReleaseData({ fetchImpl = fetch, token = process.env.GITHUB_TOKEN, outputPath = resolve("docs/releases.json") } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Axiom-release-catalog"
  };
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetchImpl(API_URL, { headers });
  if (!response.ok) throw new Error("GitHub Releases API returned HTTP " + response.status);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("GitHub Releases API returned an unexpected response.");
  const data = normalizeReleaseData(releases);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateReleaseData().then(data => {
    console.log("Release catalog generated:", JSON.stringify({
      windows: data.windows?.version || null,
      android: data.android?.version || null
    }));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
