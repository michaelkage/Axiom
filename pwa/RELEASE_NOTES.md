# Axiom Android 1.2.0

## Mobile workspace expansion

- Added startup progress feedback with an eight-second runtime handshake fallback, offline continuation, and retry action.
- Added persistent Dark, Light, and High-Contrast themes, plus a custom accent color. Saved appearance is applied before React paints to reduce theme flash.
- Added Web Speech API dictation to the composer with interim transcript feedback, a live waveform, and editable transcription before sending.
- Added image and project/text file attachments with client-side image compression, an enforced 1 MiB per-file limit, and a maximum of eight attachments per prompt.
- Added Android Web Share Target registration for shared text, URLs, logs, and supported files. The service worker stores a one-time IndexedDB handoff and opens a prefilled Axiom prompt.
- Added bounded exponential retries for transient Ollama network, rate-limit, and server errors. Retry-After is respected, retry attempts are configurable, and Stop cancels active requests and pending backoff.
- Added a mobile source editor with syntax highlighting, line numbers, find/replace, revert, and safe save/export behavior.
- Added one-tap structured conversation summaries covering What Changed, Files Touched, Verification Status, and Remaining Next Steps. Summaries do not rerun verification.
- Added a versioned skills architecture and curated marketplace with three official starter skills, manifest/schema validation, full instruction inspection, custom HTTPS manifest installation, updates, and per-conversation activation.
- Skill instructions are treated as untrusted guidance. Declared permissions do not grant capabilities or bypass existing tool approvals.
- Added regression coverage for retries, cancellation, attachment limits, summary evidence, skill validation, editor behavior, and Web Share Target registration.

## Platform boundaries

- Voice dictation depends on browser Web Speech API support and speech-service availability.
- Image payloads are sent to Ollama vision-capable models. The current native llama.cpp chat path remains text-only.
- Image bytes are kept in memory for the active session and excluded from LocalStorage persistence.
- The Files editor works on a user-selected in-memory copy. Browsers without File System Access API support export a new edited copy; the editor does not directly access Axiom's private Android runtime workspace.
- Skills currently activate per conversation/task. Project-level activation requires the future project/workspace model.
- Android APK remains ARM64 and debug-signed for sideload/testing. Physical-device voice, share-sheet, file-save, GPU, thermal, and memory-pressure validation must be completed separately.

---

# Axiom Android 1.1.5

- Added a native Android document picker to import local GGUF model files directly into Axiom private storage. Imports are streamed, checked against available storage, SHA-256 hashed, and atomically installed.
- Added an explicit Ollama server URL field in the Models screen with a discover action, so users can point Axiom at a reachable model server without digging through Settings.
- Removed the hardcoded Qwen first-run suggestion. Axiom only shows discovered models and does not invent or preselect a model when none is installed.

# Axiom Android 1.1.4

Axiom Android 1.1.4 removes the phantom default model and requires a confirmed installed model before chat can run.

## 1.1.4 changes

- Removes the hardcoded `qwen2.5:1.5b` startup model.
- Validates a saved model against the connected Ollama host before showing or using it; stale selections are cleared when the model is no longer installed.
- Shows an explicit empty-library state instead of inventing an active model.
- Prevents chat requests until an installed Ollama model or loaded native model is available.
- Removes the editable default-model field, so chat selection comes only from the installed-model list.
- Starts the native Hugging Face model search with an empty query instead of pre-filling a Qwen search.
- Distinguishes an empty Ollama library from an unreachable runtime.

# Axiom Android 1.1.3

Axiom Android 1.1.3 fixes Ollama model selection after downloads and adds secure in-app GitHub and Supabase credential management.

## 1.1.3 changes

- Automatically selects a successfully downloaded Ollama model for the next chat instead of leaving the previous default active.
- Adds GitHub Personal Access Token and repository fields to Settings.
- Adds Supabase project URL and publishable/legacy anon key fields to Settings.
- Stores provider credentials only on the authenticated gateway host in a private owner-only configuration file; secrets are never returned to the app or written to local storage.
- Adds credential removal controls and validates Supabase keys, URL transport, and GitHub repository scope.
- Provider tools can only be enabled after the gateway successfully verifies the upstream credentials. Tool registration is no longer presented as provider connectivity.
- Adds regression tests for secure credential persistence, validation, diagnostics, and model selection.

# Axiom Android 1.1.2

Axiom Android 1.1.2 improves Ollama compatibility diagnostics and preserves actionable upstream error details.

## 1.1.2 changes

- Ollama HTTP failures now include the upstream error message instead of only the status code.
- Missing Ollama models are identified explicitly, with instructions to install the selected model from Model Store.
- Added regression coverage for JSON model-not-found responses and plain-text HTTP failures.

## 1.1.1 highlights

Axiom Android 1.1.1 improves native local-model workflows, secure gateway pairing, and the mobile-first workspace.

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
- Added automatic Termux-to-Android gateway pairing through an explicit package-scoped intent; the bootstrap credential is validated, immediately removed from the launch intent, encrypted with Android Keystore, and exchanged for renewable short-lived sessions.
- Suppressed first-run gateway credential output in the Termux bootstrap so secrets are not written to its gateway log.
- Restricted native gateway authentication to HTTPS or same-device loopback HTTP and disabled redirects on credential-bearing requests.
- Kept GitHub and Supabase integration credentials on the gateway host rather than persisting them in browser storage.
- Added encrypted Android storage for gateway pairing credentials and Hugging Face read tokens using Android Keystore.
- Added server-side MCP proxying and repository-scoped GitHub/Supabase gateway routes.
- Added first-run setup guidance and a persistent setup-guide entry point with a one-command Termux bootstrap and automatic Android pairing.

### Mobile experience and reliability
- Added the native interactive terminal runtime, PTY input/output, resize handling, cancellation controls, and app-private workspace support. The terminal is explicitly documented as an Android developer shell, not a Termux/Linux distribution; unsupported tools are not presented as available.
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
4. Launch Axiom. If you want the optional Termux/Ollama gateway, run the one-command bootstrap from the in-app setup guide. It pairs the app automatically without displaying or copying a token.

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
