# Axiom native Android model runtime

Axiom's Android APK includes a native llama.cpp inference engine. It is separate from the optional Ollama provider and does not require Termux, a local Node gateway, or a network connection after a model has been installed.

## Architecture

- **Inference:** llama.cpp is fetched at the pinned upstream tag `b12248` and compiled by CMake with the Android NDK. CPU kernels use runtime feature selection; the ARM64 build enables KleidiAI. The build disables host-native CPU flags, OpenMP, llamafile, and OpenSSL. It compiles the Vulkan backend alongside the ARM64 CPU backend; GPU offload is attempted only when Android reports a real Vulkan physical device.
- **Android bridge:** Capacitor plugin `AxiomModels` exposes model storage, downloads, device capabilities, load/unload, generation and cancellation. JNI calls llama.cpp directly inside the app process.
- **Storage:** GGUF files live in `context.filesDir/models`, which is private to Axiom. A partial download uses a `.part` file; a completed file is installed by same-directory rename. A JSON sidecar stores source, size and SHA-256 metadata.
- **Discovery:** Public Hugging Face model search is followed by an authenticated-free Hub tree request to enumerate actual GGUF files. The user chooses the file/quantization rather than assuming a repository has a particular Q4 file.
- **Chat:** llama.cpp applies the loaded model's chat template where its built-in template parser supports it. Native generation streams token events to React, observes cancellation, and uses Axiom's existing tool registry and explicit approval flow.
- **Optional remote providers:** Ollama remains available in browser/PWA mode and as an optional external provider. Loading a native GGUF model on Android routes chat to the native engine.

## Device and model compatibility

- The Android native inference build targets `arm64-v8a`. 32-bit ARM and x86 APK ABIs are not included in this native runtime build.
- The runtime includes both the ARM64 CPU backend and a compiled Vulkan backend. llama.cpp attempts GPU layer offload when a Vulkan physical device is enumerated. If GPU model loading fails, the native engine retries CPU-only. The model screen reports the Vulkan device and the active/requested GPU layer count. A Vulkan loader alone is not considered proof of a usable GPU.
- Device capabilities include available/total RAM, storage, CPU core count and ABI. A conservative pre-load memory estimate is applied in the UI, but Android can still kill an app under memory pressure. Start with a small 1B-2B Q4 GGUF and 1K-2K context.
- Context length is bounded to 512-8192 in the native bridge. The UI starts at 1024 or 2048 based on available RAM. Generation is capped at 4096 tokens.
- GGUF chat templates are not a full Jinja implementation. If a repository uses a template unsupported by llama.cpp's built-in legacy template parser, Axiom falls back to a plain role-labelled prompt. Tool calling is model-dependent; the app requests a strict JSON tool-call format and still requires approval for registered tools.
- Public Hugging Face repositories work without authentication. A read-only Hugging Face token can be saved through the Android model store; it is encrypted with Android Keystore and attached only to Hub metadata/download requests. Exact owner/repository IDs can be entered directly to inspect private repositories. Gated repositories still require the user's account to have been granted access on Hugging Face. The token is not stored in localStorage or emitted to logs.

## Integrity and download behavior

- The Hub file listing provides the expected byte count and, where exposed, the LFS SHA-256 OID.
- Downloads use HTTP Range to resume an existing partial file when the server honors the range request.
- The completed size is checked against Hub metadata.
- SHA-256 is computed locally and compared with the Hub's expected SHA-256 when available. If Hub metadata does not expose a digest, the locally computed digest is stored as a fingerprint, not represented as a remote-authenticated checksum.
- Files are written under the private model directory. The final file is not exposed in the library until the completed download passes checks and the partial file is renamed.
- Clearing Axiom app data or uninstalling the app removes the private model library.

## Build

The Android workflow installs NDK 27.2.12479018 and CMake 3.22.1, generates the Capacitor Android project, runs `scripts/install-android-native.mjs`, and invokes Gradle `assembleDebug`. The installer registers both Capacitor plugins and configures the native CMake target.

llama.cpp is fetched at the pinned `b12248` tag during native build. This requires GitHub access in the build environment. The resulting APK is ARM64-targeted and includes the native inference library.

## Current limitations and validation

- Vulkan GPU offload is compiled and attempted when a physical Vulkan device is available, with CPU fallback if GPU model loading fails. Physical GPU correctness, performance and stability still require device testing; no Adreno/Hexagon-specific backend is claimed.
- The native runtime has not yet been physically validated across Android devices. CI compilation proves the APK can be built, not that every model/driver/device combination will run.
- Long-running inference is currently hosted in the app process. Background inference and persistent model sessions are not promised.
- Model metadata parsing is currently based on Hub file metadata, not a full GGUF metadata/architecture preflight. Unsupported or incompatible files fail at load time with an actionable error.
