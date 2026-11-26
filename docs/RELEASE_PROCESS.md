# Axiom release process

## Release prerequisites

1. Merge the intended release commit to `main`.
2. Confirm the Axiom CI workflow passes.
3. Keep the root and desktop package versions identical.
4. Add release notes at `docs/releases/vX.Y.Z.md`.
5. Confirm the target platform workflows are green before announcing downloads.

The release workflows create packages; they do not replace manual testing on physical target machines.

## Build and publish

- Tag-triggered `.github/workflows/release.yml` builds the Windows x64 installer, runs the Windows installation/startup smoke test, generates a SHA-256 checksum, and publishes the Windows assets to the GitHub Release.
- `.github/workflows/release-platforms.yml` builds macOS Intel/Apple Silicon DMG and ZIP packages and Linux AppImage, DEB, and RPM packages.
- macOS Release uploads require the configured Apple certificate, team, Apple ID, and app-specific password secrets. Without those credentials, unsigned packages remain CI artifacts and are not attached as distributable release assets.
- Linux packages are attached to the matching tagged GitHub Release.
- macOS packages are attached to the matching tagged GitHub Release only when signing/notarization credentials are configured.

## Windows installer smoke test

The release workflow installs the NSIS package silently on a clean Windows runner, launches the installed executable, and waits for three independent startup signals:

- the bundled local runtime reports that it is ready on loopback;
- the Electron renderer reports that it loaded;
- the Axiom UI reports that it mounted.

The test fails if the process exits, startup diagnostics contain known failure messages, or any signal is missing within the timeout. This is automated smoke coverage on a GitHub-hosted Windows runner. It does not establish that interactive provider setup, project switching, or all user workflows work on every Windows configuration.

Before announcing a release, perform a manual interactive check on a clean Windows machine:

1. Install the downloaded release asset using the normal interactive installer.
2. Launch Axiom from the Start menu and confirm the welcome screen appears without a black window.
3. Open a small local project and confirm the runtime becomes ready.
4. Configure a supported model provider and verify a short request.
5. Switch to another project and confirm the new workspace loads.
6. Close Axiom and confirm the runtime shuts down.
7. Reopen Axiom and confirm it starts cleanly.

Record the machine OS/build, Axiom version, test result, and sanitized diagnostics. Do not describe the release as manually smoke-tested until these steps have actually been completed.

## Verify Windows installer integrity

Download the `.sha256` asset beside the installer. In PowerShell, from the folder containing the installer:

```powershell
$installer = Get-ChildItem .\Axiom-Setup-*-x64.exe | Select-Object -First 1
Get-FileHash $installer.FullName -Algorithm SHA256
Get-Content "$($installer.FullName).sha256"
```

The computed SHA-256 value must match the value in the checksum file. Do not run an installer whose checksum does not match.

## Release notes

Store version-specific notes in `docs/releases/vX.Y.Z.md`. Keep the root README focused on product value, supported downloads, and contributor entry points.
