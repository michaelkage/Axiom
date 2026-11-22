# Axiom isolated plugin runtime

Axiom's desktop main process owns plugin discovery, authorization and execution. The renderer can request a plugin by ID but cannot supply a manifest, entry-point path, executable, working directory or workspace path.

## Installation layout

The host scans the Electron `app.getPath("userData")` directory:

```text
axiom-plugins/
  example.plugin/
    manifest.json
    index.cjs
```

Plugin installation/import UI is not implemented yet. A plugin directory must be placed in this location by a trusted installation process. Axiom ignores invalid manifests and symlinked plugin directories.

## Manifest

```json
{
  "apiVersion": 1,
  "id": "example.plugin",
  "name": "Example Plugin",
  "entry": "index.cjs",
  "capabilities": ["project.read"],
  "resources": {
    "timeoutMs": 30000,
    "memoryMb": 128
  }
}
```

The ID must match the installation directory. The entry point must resolve to a regular file within that directory. Only the declared capability set is passed to the sandbox. Axiom displays a native main-process approval prompt for each plugin execution and shows the complete requested capability list.

## Runtime boundary

On Linux, Axiom uses Bubblewrap with isolated user, mount, PID, IPC and network namespaces; a read-only plugin mount; an optional workspace mount (read-only for `project.read`, writable only for `project.write`); a private temporary directory; dropped Linux capabilities; resource limits; bounded output; and a hard execution timeout. The process receives only a constrained environment. Plugin execution is refused when Bubblewrap cannot be started.

On Windows and macOS, plugin execution remains disabled because a verified native sandbox adapter is not yet available. The plugin inventory can still be inspected without initializing the platform adapter.

## Current limitations

- Plugin installation, signature verification, update management and a user-facing plugin manager are not implemented.
- Network, shell, MCP and artifact capability brokers are not implemented; plugins should not request these capabilities. A future release must enforce these through mediated APIs rather than treating manifest declarations as enforcement.
- Bubblewrap has not yet been exercised on a real Linux installation in this development environment.
- This runtime is an implementation foundation, not a claim of a completed or independently audited plugin security boundary.
