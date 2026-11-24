# Axiom 0.4.10

## Fixes

- **Fix Windows startup from paths containing spaces.** The desktop app now prefers the bundled native Windows runtime executable and launches native executables without routing them through a command shell. This addresses startup failures on installations under paths such as `C:\\Program Files\\Axiom`.
- Keep the bundled local runtime startup path aligned with the standalone Axiom desktop app.

## Verification

- Windows desktop packaging and installed-app smoke-test workflow passed on the release candidate commit.
- Axiom CI passed.
- MCP runtime checks passed.

## Notes

This release addresses the Windows runtime launch failure reported in 0.4.9. These automated checks do not replace testing on every Windows configuration. If startup still fails, use **Help → Open Axiom Runtime Log** and include the log when reporting the issue.
