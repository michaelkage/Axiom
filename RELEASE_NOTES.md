# Axiom v0.4.12 — Release notes

This release focuses on making Axiom's bundled desktop runtime easier to diagnose and the worker execution lifecycle more observable.

## Improvements

- Preserve the runtime session ID when an MCP worker request fails, including HTTP errors and message-request timeouts.
- Persist the diagnostic session ID in failed worker task history so troubleshooting can resume from the relevant runtime session.
- Keep actionable worker failure messages in task diagnostics and logs instead of reducing failures to a generic status.
- Expand desktop integration coverage for worker failure, retry, stale attempt events, interrupted-task recovery, and MCP diagnostic success/failure persistence.
- Add coverage for MCP request timeouts and retained diagnostic session identifiers.
- Add a Windows x64 release workflow that builds the standalone UI, checks the bundled runtime entrypoints, runs unit and desktop tests, packages the installer, and publishes it to GitHub Releases.

## Important verification note

The MCP worker diagnostic integration tests use controlled runtime responses. They improve coverage of persistence and error handling, but do not by themselves prove that a real external MCP server was called successfully in a packaged desktop installation.

The release workflow must complete successfully before the installer should be considered verified. The Windows x64 installer is the supported release artifact for this version.

## Install

Download `Axiom-Setup-0.4.12-x64.exe` from the GitHub Releases page once the release workflow has published it.

## Known limitations

- This release does not claim end-to-end proof of a live MCP server invocation against every provider.
- The installer workflow currently targets Windows x64.
