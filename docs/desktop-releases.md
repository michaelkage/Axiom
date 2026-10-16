# Desktop releases

The desktop release workflow is `.github/workflows/release.yml`. It builds the standalone UI, packages the Windows x64 NSIS installer, calculates a SHA-256 checksum, and uploads both files as workflow artifacts. When the workflow is triggered by a version tag beginning with `v`, it also attaches those files to a GitHub Release.

## Publish a release

1. Ensure `package.json` and `desktop/package.json` have the same version.
2. Merge or push the exact commit intended for release.
3. Create and push a tag matching that version, prefixed with `v`. For example, for version `0.4.4`:

   ```sh
   git checkout axiom/product-rebuild
   git pull
   git tag v0.4.4
   git push origin v0.4.4
   ```

4. Open the repository's **Actions** tab and watch **Build Axiom Desktop Release**. The release job validates that the tag version matches both package manifests, builds the installer, and publishes the release assets.
5. Open **Releases** and select the new `Axiom 0.4.4` release. Under **Assets**, confirm both `Axiom-Setup-0.4.4-x64.exe` and its `.sha256` checksum are present.

The tag is what triggers publication. A normal push to `axiom/product-rebuild` builds and uploads a workflow artifact but does not publish a GitHub Release. Manually running the workflow also produces an artifact; the current publish step is intentionally tag-only.

## Downloading the installer

Users should download the `.exe` from the release's **Assets** list, not from GitHub's automatically generated source-code ZIP or TAR.GZ files. The checksum file can be used to verify the downloaded installer:

```powershell
Get-FileHash .\Axiom-Setup-0.4.4-x64.exe -Algorithm SHA256
```

Compare the resulting hash to the value in the matching `.sha256` asset.

## Current platform coverage

The current release workflow publishes a Windows x64 installer only. macOS and Linux installers are not yet configured as release assets. Do not advertise those platforms as downloadable until separate packaging jobs and clean-install checks are added.
