# Axiom Desktop and iOS platform support

## Desktop runtime and platform adapters

The desktop renderer remains SolidJS and the mobile PWA remains React. They share the domain contracts in `src/shared/platform.ts`; platform-specific capabilities are provided by the Electron adapter in `src/webview/utils/platformAdapter.ts` and the mobile adapter in `pwa/src/lib/platformAdapter.js`.

Electron exposes project file operations and credential storage through the context-isolated preload bridge. Credentials are encrypted with Electron `safeStorage` and persisted only as ciphertext in the app's user-data directory. Axiom refuses to write credentials when Electron reports the `basic_text` backend. On macOS this delegates encryption to Keychain; on Windows to DPAPI; on supported Linux desktops to the configured secret service.

Mobile browser credentials use AES-GCM with a non-extractable Web Crypto key stored in IndexedDB. iOS uses the native Keychain plugin. Android continues to use the Android runtime's native credential facilities where implemented; the general adapter uses its Web Crypto vault for credentials not yet exposed by a native Android API.

Desktop filesystem access is restricted to the folder selected by the Electron host. The adapter does not expose arbitrary absolute paths to renderer code.

## macOS desktop builds

The desktop release workflow builds separate Intel x64 and Apple Silicon arm64 DMG and ZIP packages. Runtime lookup checks the platform/architecture-specific OpenCode executable before falling back to the packaged CLI shim.

To produce a Gatekeeper-trusted release, configure these GitHub repository secrets:

- `APPLE_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application certificate export.
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting the P12.
- `APPLE_ID`: Apple Developer account email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that account.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

When all signing/notarization credentials are present, electron-builder signs with the supplied certificate and notarizes the DMG. Without them, CI can still produce unsigned DMG/ZIP artifacts for internal testing; macOS Gatekeeper will not treat those as trusted distribution builds.

The app uses Electron safeStorage for Keychain-backed credential encryption and explicitly enables loopback network client/server access for the local OmniRoute service on `127.0.0.1:20128`.

## iOS Capacitor shell

The iOS project is generated from the shared React PWA:

```sh
cd pwa
npm ci
npm run build
npm run ios:add
gem install xcodeproj
npm run ios:configure
npm run ios:sync
npm run ios:open
```

The native configuration script adds:

- A Capacitor plugin backed by iOS Keychain for provider credentials.
- SFSpeechRecognizer and AVAudioSession speech dictation events.
- UIDocumentPicker imports copied into Axiom's private Documents/Imports directory.
- An iOS Share Extension target using the shared app group `group.com.axiom.mobile`.

The Share Extension writes text, URLs and shared file contents to the app-group container. The app consumes the payload when it next becomes active. iOS does not allow a Share Extension to arbitrarily launch its containing app, so Axiom does not claim that selecting the extension always switches apps automatically. Shared files are limited to 1 MiB aggregate before they enter the prompt attachment flow.

### TestFlight automation

The `.github/workflows/ios-testflight.yml` workflow builds an unsigned iOS Simulator artifact on every manual run and `ios-v*` tag. It archives and uploads an App Store IPA to TestFlight only when all of the following GitHub secrets are configured:

- `IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64`
- `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`
- `IOS_TEAM_ID`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_BASE64`

The App Store Connect key must have permission to manage the app and TestFlight builds. The Apple Developer account must have the bundle identifiers `com.axiom.mobile` and `com.axiom.mobile.share`, and the App Group `group.com.axiom.mobile` must be registered and enabled for both identifiers. Automatic signing is requested by Xcode during archive/export.

No signing secrets are committed to this repository. Without these secrets, the workflow deliberately stops at the unsigned simulator build and does not pretend a TestFlight upload occurred.

## Validation boundaries

CI compilation does not replace physical-device validation. Before public distribution, validate Keychain persistence across restarts, microphone and speech permissions, real document imports, share extension handoff from Safari/Files/Notes, App Group provisioning, VoiceOver, keyboard behavior and TestFlight installation on supported iOS versions.
