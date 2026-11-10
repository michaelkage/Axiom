# Axiom Mobile 1.1.0

## Security and gateway
- Added an authenticated local Node.js gateway with constant-time bearer-token comparison, exact CORS origin allowlists, bounded request bodies, fixed Ollama routes, and disconnect-aware upstream cancellation.
- Added allowlisted Streamable HTTP MCP proxying with server-side credentials.
- Added a GitHub content API proxy restricted to one configured repository.
- Added a Supabase REST proxy that accepts publishable keys or legacy anon JWTs and rejects secret/service-role keys.
- Removed integration credentials from LocalStorage. The gateway token and any legacy direct credentials remain session-only in the browser.
- Added an explicit tool-approval dialog with inspectable arguments and keyboard dismissal.

## Mobile experience
- Added conversation deletion.
- Bounded persisted chat history and handled LocalStorage quota errors.
- Added Android keyboard and session-only credential browser tests.
- Added physical Android Chrome installation, offline, networking, and sign-off checklist.

## Build and release
- Added and committed the npm v3 lockfile.
- Mobile CI now uses `npm ci` and audits production dependencies.
- Added tagged release verification and a packaged PWA artifact workflow.

## Known release gate
Physical Android device verification and deployment to a chosen HTTPS static host are not complete until a device test record and hosting target are supplied.
