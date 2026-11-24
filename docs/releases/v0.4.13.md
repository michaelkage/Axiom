# Axiom v0.4.13 — Desktop rendering and startup diagnostics

This release addresses a likely cause of the black desktop window and strengthens verification so a successful Electron document load is no longer mistaken for a working Axiom interface.

## Fixes and improvements

- Configure Vite to emit relative asset paths so the standalone UI can load from Electron's packaged `file://` page.
- Check whether the Axiom renderer actually mounted its root UI after the document loads.
- Record an explicit `Axiom UI mounted.` diagnostic, or a mount failure, in the desktop runtime log.
- Require the packaged Windows installer smoke test to verify that the UI mounted, in addition to checking runtime and renderer startup.

## Verification notes

The relative asset-path change addresses a plausible cause of the reported black screen. The Windows release workflow now checks for a populated UI root instead of relying only on Electron's `did-finish-load` event. This is a stronger automated check, but it does not replace confirming the full interactive workspace on a user's machine.

MCP diagnostic integration tests use controlled runtime responses and do not by themselves prove that a real external MCP server was called successfully in a packaged installation.

## Install

Download `Axiom-Setup-0.4.13-x64.exe` from the GitHub Releases page after the release workflow completes successfully.

## Known limitations

- The installer workflow currently targets Windows x64.
- Full live external MCP-provider verification remains separate from the desktop startup smoke test.
