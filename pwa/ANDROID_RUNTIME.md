# Native Android runtime

The Capacitor APK includes an Android-only native runtime. Browser/PWA mode deliberately does not expose shell execution.

## PTY and workspace model

- The native plugin uses Android Bionic forkpty() (API 23+) and launches /system/bin/sh -i.
- PTY input/output, terminal resize (TIOCSWINSZ), Ctrl+C, Ctrl+D, Ctrl+L, and process teardown are bridged through Capacitor. Default row/column dimensions are configurable in Settings; the UI auto-fits columns to its available width.
- Workspaces live under the app-private filesDir/workspaces directory. The active workspace is persisted in native preferences and becomes the shell's initial working directory.
- Workspace names are validated and canonicalized. A terminal cannot select an arbitrary filesystem path or escape the private workspace root.
- This is an Android system shell, not Termux. Only commands shipped by Android or included in the app sandbox are available. It does not bundle package managers, Git, Python, Node, Bash, or a full-screen VT emulator. The terminal view is intentionally line-oriented; interactive shell line editing and signal handling work through the PTY, but full-screen applications such as vim/top are not supported by its current renderer.

## Background execution

The user can explicitly start/stop the foreground runtime service from Settings. Android displays an ongoing notification while it is active. The optional partial wake lock is acquired only when the user enables Keep CPU awake and is released when disabled or when the service is destroyed.

Android 14+ declares specialUse for continued user-started local terminal/developer work. Store review may require a clear explanation of this use case. A foreground service and wake lock reduce background suspension but do not defeat force-stop, reboot, OEM task killers, battery restrictions, or process crashes. Do not treat them as durable remote execution.

## Gateway credential lifecycle

1. On first startup, the Node gateway generates a random 256-bit pairing token when AXIOM_GATEWAY_TOKEN is not explicitly configured.
2. It saves the token to ~/.config/axiom/gateway-token with owner-only directory/file permissions and prints the value once. Subsequent starts reuse the saved value without printing it again.
3. The user pastes that one-time value into Android Settings once. The native plugin encrypts it with an AES-GCM key held by Android Keystore; only ciphertext is stored in app-private preferences.
4. The Android plugin generates a 256-bit random session token in process memory and registers it with POST /session/register.
5. The gateway accepts that token for 12 hours. The session token is not persisted to browser storage. After an app process restart, the plugin registers a new in-memory token using the stored pairing credential.
6. Restarting the gateway clears all ephemeral sessions; the app registers again on its next startup.

## Optional Termux/Ollama compatibility bridge

For users who want local Ollama inference before the native engine is available, follow [Android local AI setup](./TERMUX_SETUP.md). It installs a pinned community ARM64 Termux Ollama build and runs the Axiom gateway on the phone. The Termux app itself must be installed manually from an official Termux distribution source. This is a temporary bridge, not the native Axiom runtime; the community Ollama fork is archived and is not an official Ollama Android release.

## Model discovery and installation

The Models tab automatically refreshes the configured Ollama model list and can pull models from the Ollama registry or compatible Hugging Face GGUF repositories. Ollama downloads and stores those models on the machine running the Ollama service. The app monitors Ollama while open, retries connection checks periodically, and checks again when network connectivity returns.

The standard Ollama daemon is not packaged for Android. If Ollama runs in Termux or on another machine, configure the gateway to reach it. Installing a desktop Ollama binary inside the APK is not a valid Android deployment strategy. Fully on-device Android inference requires a separate Android-native engine; this release does not claim to install one.

The gateway itself remains a separate Node.js process in this release. 127.0.0.1 on Android means the phone, not a development computer. For a gateway hosted on another device, configure a trusted HTTPS URL reachable by the phone and allow the Capacitor origin (https://localhost) in AXIOM_ALLOWED_ORIGINS. The Android network security exception permits cleartext only to localhost and 127.0.0.1; LAN gateway traffic should use HTTPS.

## Build

The Android release workflow generates the Capacitor project, runs scripts/install-android-native.mjs, compiles the JNI PTY library with the Android NDK/CMake, and builds the APK.

For a local build:

    cd pwa
    npm ci
    npm run build
    npx cap add android
    npx cap sync android
    node scripts/install-android-native.mjs
    cd android
    ./gradlew assembleDebug

The installer is idempotent and is required after regenerating the Capacitor Android project.
