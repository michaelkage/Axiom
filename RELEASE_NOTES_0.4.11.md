# Axiom 0.4.11

## Fixes

- Isolate the bundled runtime's persistent data from databases created by other installations, avoiding startup failures caused by incompatible shared runtime databases.
- Keep runtime data in Axiom's app-specific user-data directory on Windows and Linux.
- Log the resolved runtime data directories to make startup failures easier to diagnose.
- Preserve existing shared runtime data in place; Axiom does not delete or overwrite it during this migration.

## Verification

- Desktop unit tests cover runtime environment isolation and preservation of unrelated environment settings.
- The release workflow builds the standalone Windows installer and smoke-tests the installed app by checking that the local runtime and Axiom UI become ready.
- CI and MCP runtime tests are run against the release commit.

## Troubleshooting

If startup still fails, open **Help → Open Axiom Runtime Log** and share the log. This release's automated smoke test verifies a fresh profile; it does not simulate every pre-existing database state or every Windows configuration.
