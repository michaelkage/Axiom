# Axiom Android 1.1.0

Axiom Android 1.1.0 brings the native local-model runtime into the mobile app, alongside the existing secure gateway and mobile-first workspace.

## Highlights

### Native on-device AI
- Added an ARM64 Android native inference runtime built on llama.cpp (pinned upstream revision).
- Added GGUF model discovery from Hugging Face, quantization selection, license visibility, resumable downloads, SHA-256 verification, and atomic installation into app-private storage.
- Added native model loading, tokenization, streaming generation, sampling, cancellation, and unload support.
- Added local model storage accounting, context configuration, and RAM-aware load checks.
- Preserved the existing Ollama path as a fallback and kept tool approval/execution in the normal chat flow.

### Vulkan and runtime diagnostics
- Enabled the Vulkan backend in the Android native build and added GPU offload requests with CPU fallback.
- Added runtime diagnostics for model load time, first-token latency, prompt/generation throughput, memory, battery temperature, thermal state, cancellation, and GPU capability reporting.
- Added a five-round on-device validation flow with a copyable diagnostic report.

**Hardware note:** Vulkan support is compiled into this build, but actual GPU execution and performance depend on the Android device and driver. Physical-device GPU, thermal, and memory-pressure validation has not yet been completed.

### Security and integrations
- Added authenticated gateway pairing and renewable short-lived sessions.
- Kept GitHub and Supabase integration credentials on the gateway host rather than persisting them in browser storage.
- Added encrypted Android storage for gateway pairing credentials and Hugging Face read tokens using Android Keystore.
- Added server-side MCP proxying and repository-scoped GitHub/Supabase gateway routes.
- Added first-run setup guidance and a persistent setup-guide entry point, including recovery instructions for the gateway token.

### Mobile experience and reliability
- Added the native interactive terminal runtime, PTY input/output, resize handling, cancellation controls, and app-private workspace support.
- Added foreground-service support for long-running native work, with optional wake-lock behavior.
- Added connection recovery, bounded conversation persistence, and improved error handling.
- Refined the mobile interface with a higher-contrast neo-brutalist visual system.

## Verification

- Android ARM64 APK built successfully in GitHub Actions.
- Native C++ runtime compiled and linked with the Vulkan backend enabled.
- Desktop CI, desktop end-to-end tests, PWA unit tests, and production builds passed for the release candidate.
- The APK was inspected to confirm the ARM64 native library and statically linked llama.cpp runtime are present.

Automated CI does not replace testing on physical Android hardware. The device validation flow is included in the app for that final check.

## Install

1. Download `Axiom-Android-arm64-debug.apk` from the Assets section below.
2. Open the APK on an ARM64 Android device.
3. Allow installation from the browser or file manager if Android prompts.
4. Launch Axiom and complete gateway pairing from the setup guide.

## Release details

- **Platform:** Android ARM64
- **Package:** Debug-signed APK for direct sideloading
- **Distribution:** GitHub Releases
- **Google Play:** Not published
- **Physical-device validation:** Pending

## Known limitations

- This is a debug-signed sideload build, not a Play Store or production-signed package.
- Only Android ARM64 is packaged.
- Vulkan compilation and offload requests do not guarantee that a device's driver will execute inference on its GPU.
- The gateway is a separate Node.js service and must be reachable over the configured network; it is not embedded in the APK.
- Android force-stop, reboot, and manufacturer battery-management policies can stop background work.
- Physical-device performance, thermal behavior, and memory-pressure results remain unverified.
