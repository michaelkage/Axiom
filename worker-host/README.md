# Axiom Worker Host

A separately deployed Node.js 20+ service that runs OpenCode on the machine owning the execution workspace. It is distinct from the desktop Git clone/push helper.

## Requirements and startup

Install Git and the OpenCode CLI on the host. Configure repository access using host-side Git credentials or an SSH agent. Set AXIOM_WORKER_HOST_TOKEN to a random secret of at least 32 characters. Optional settings: AXIOM_WORKER_DATA, AXIOM_WORKER_HOST_BIND, AXIOM_WORKER_HOST_PORT, AXIOM_OPENCODE_BIN.

Run npm start from this directory. The default bind address is 127.0.0.1. For remote clients, bind only to a private interface behind TLS termination and a firewall. The service does not provide TLS itself.

## Protocol v1

- GET /v1/health: protocol compatibility.
- POST /v1/jobs: submit idempotent task metadata, prompt, repository URL and branch.
- GET /v1/jobs/:id: retrieve durable job state.
- GET /v1/jobs/:id/events: bounded Server-Sent Events log stream.
- POST /v1/jobs/:id/cancel: request cancellation; terminal cancellation is recorded only after the worker process exits.

All endpoints require Authorization: Bearer TOKEN. Job metadata and bounded logs are persisted. Active jobs found after an unclean restart become interrupted and are never retried. Their workspaces are retained for inspection. The host clones a clean isolated checkout and invokes opencode run using an argument array, not a shell string. It does not commit or push changes; review and publication remain explicit client actions.

## Security

Use a dedicated service account and private network. Never expose this service directly to the public internet. The bearer token is a shared secret, not a substitute for TLS. Repository credentials remain on the host and are never accepted in task requests. Requests and retained logs are bounded; token comparison is constant-time.
