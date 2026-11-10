# Axiom Mobile deployment

Axiom Mobile is a static PWA plus a separate authenticated gateway. Deploying only the static files does not deploy Ollama, GitHub, Supabase, or MCP access.

## Static PWA hosting

Use any static host that serves HTTPS and supports a service worker. For a monorepo host configuration:

- Base / root directory: `pwa`
- Install command: `npm ci`
- Build command: `npm run build`
- Publish / output directory: `dist`
- Node version: 22

The Vite app is currently configured for the domain root (`/`). If hosting under a path prefix such as `/Axiom/`, update Vite's `base`, manifest `start_url` and `scope`, icon URLs, and service-worker registration/cache paths together before deploying.

Recommended response headers:

- Serve `index.html` and `manifest.webmanifest` with revalidation.
- Serve hashed files under `assets/` with long-lived immutable caching.
- Serve `sw.js` with `Cache-Control: no-cache` so clients can receive updates.
- Keep the manifest and service worker same-origin with the PWA.

## Gateway hosting

Run the Node gateway separately on the machine that can reach Ollama and the configured integrations. See [gateway/README.md](./gateway/README.md).

For a phone connecting to a gateway on another machine:

1. Put a trusted HTTPS reverse proxy in front of the gateway.
2. Configure an exact `AXIOM_ALLOWED_ORIGINS` entry matching the deployed PWA origin.
3. Bind the gateway only to the required LAN interface and firewall it to trusted devices/networks.
4. Configure a strong random `AXIOM_GATEWAY_TOKEN` and the server-side integration environment variables.
5. In Axiom Settings, enter the HTTPS gateway URL and bearer token. The browser keeps the token in memory only.

Do not expose the raw Node gateway port to the public internet. It is a single-user local trust boundary, not a hardened public multi-tenant API.

## Release process

1. Confirm the Mobile PWA build workflow is green on `main`.
2. Create a tag such as `mobile-v1.1.0`.
3. The tagged release workflow runs `npm ci`, the production dependency audit, unit tests, build, and mobile browser tests.
4. Download the `axiom-mobile-mobile-v1.1.0` workflow artifact and publish its `dist/` contents to the HTTPS static host.
5. Complete [ANDROID_VALIDATION.md](./ANDROID_VALIDATION.md) on a physical Android device before declaring the release Android-verified.

## Android APK download

The Android workflow builds an installable universal debug APK from the production PWA bundle.

- Run it manually from **Actions → Android APK release → Run workflow** to get a downloadable workflow artifact.
- Or create and push an `android-v1.1.0` tag to build the APK and publish it as a GitHub Release.
- Download `Axiom-Android-universal-debug.apk` from the workflow artifact or the GitHub Release assets, then open it on the Android device and allow installation from that source when Android prompts.

This debug-signed APK is intended for direct sideloading and testing. It is not signed with a private production upload key and is not the Play Store release package. A production Play Store release requires a privately managed signing key and Android App Bundle (AAB) configuration.
