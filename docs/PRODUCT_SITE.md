# Axiom product site

The public product site is published through GitHub Pages at:

https://michaelkage.github.io/Axiom/

## How it works

- `docs/index.html` is a dependency-free, responsive product and download page.
- `scripts/site/generate-releases.mjs` reads the public GitHub Releases API and writes `docs/releases.json`.
- The catalog independently selects the newest stable Windows x64 installer and Android ARM64 APK. Drafts, prereleases, unrelated assets, and releases without the expected assets are ignored.
- A Windows SHA-256 checksum link is shown only when the matching checksum asset exists.
- The site refreshes on relevant pushes to `main`, on a daily schedule, or by manually dispatching **Publish Axiom product site**.
- If the browser cannot load the catalog, download links fall back to the official Releases page instead of using a hard-coded version.

## Validate locally

Requires Node.js 20 or newer.

```bash
pnpm run test:site
node scripts/site/generate-releases.mjs
```

The generator uses the public GitHub API. Set `GITHUB_TOKEN` to a repository-scoped token when a higher API rate limit is needed. Never put a token in the generated JSON or the static site.

## Release and platform accuracy

The site reflects published release assets; it does not infer release readiness from workflow artifacts.

- Windows desktop: x64 NSIS installer, with SHA-256 asset when published.
- Android: ARM64 debug-signed APK for sideloading and testing, not a Play Store production-signed package.
- Mobile PWA: the repository contains the PWA source and deployment instructions. A hosted PWA URL is not advertised unless an actual deployment URL is configured.
- macOS and Linux desktop installers are not advertised until supported packaging jobs publish those assets.

Update the site content when product capabilities or support boundaries change. Keep download links generated from release metadata rather than manually pinning versions.
