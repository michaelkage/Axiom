# Native Android runtime

The Capacitor APK includes an Android-only native runtime. Browser/PWA mode deliberately does not expose shell execution.

## PTY and workspace model

- The native plugin uses Android Bionic forkpty() (API 23+) and launches /system/bin/sh -i.
- PTY input/output, terminal resize (TIOCSWINSZ), Ctrl+C, Ctrl+D, Ctrl+L, and process teardown are bridged through Capacitor.
- Workspaces live under the app-private filesDir/workspaces directory. The active workspace is persisted in native preferences and becomes the shell's initial working directory.
- Workspace names are validated and canonicalized. A terminal cannot select an arbitrary filesystem path or escape the private workspace root.
- This is an Android system shell, not Termux. Only commands shipped by Android or included in the app sandbox are available. It does not bundle package managers, Git, Python, Node, Bash, or a full-screen VT emulator. The terminal view is intentionally line-oriented; interactive shell line editing and signal handling work through the PTY, but full-screen applications such as vim/top are not supported by its current renderer.

## Background execution

The user can explicitly start/stop the foreground runtime service from Settings. Android displays an ongoing notification while it is active. The optional partial wake lock is acquired only when the user enables Keep CPU awake and is released when disabled or when the service is destroyed.

Android 14+ declares specialUse for continued user-started local terminal/developer work. Store review may require a clear explanation of this use case. A foreground service and wake lock reduce background suspension but do not defeat force-stop, reboot, OEM task killers, battery restrictions, or process crashes. Do not treat them as durable remote execution.

## Gateway credential lifecycle

1. The gateway's existing AXIOM_GATEWAY_TOKEN is used as a one-time pairing credential.
2. In Android Settings, the user enters it once. The native plugin encrypts it with an AES-GCM key held by Android Keystore; only ciphertext is stored in app-private preferences.
3. The Android plugin generates a 256-bit random session token in process memory and registers it with POST /session/register.
4. The gateway accepts that token for 12 hours. The session token is not persisted to browser storage. After an app process restart, the plugin registers a new in-memory token using the stored pairing credential.
5. Restarting the gateway clears all ephemeral sessions; the app registers again on its next startup.

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
