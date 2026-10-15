# Axiom Master Upgrade Plan

**Status:** In progress — coordinated implementation wave  
**Product constraint:** Axiom remains a standalone desktop application. It must not become an editor extension or depend on a host IDE for its core product experience.  
**Planning principle:** Build the next upgrade set as one coordinated program with parallel workstreams, shared contracts, and one integration/verification gate—not as a series of unrelated feature requests.

## Product outcome

A new user should be able to install Axiom, open a project, understand whether model access is ready, complete a real first task, inspect changes, and recover from common failures without needing to understand the underlying runtime. Experienced users should retain direct access to model/provider choice, project context, verification evidence, and advanced orchestration.

The architecture blueprint identifies four intended pillars: multi-agent parallelization, local error healing, OmniRoute telemetry/routing, and an extensible plugin layer. Treat these as product goals, not claims that every described mechanism is already implemented. Each workstream below must inventory current code and preserve working behavior before expanding it.

## Workstream A — Provider readiness and first-run experience

**Goal:** Replace documentation-first setup with live, actionable diagnostics.

- Discover the providers and model inventory reported by the bundled OpenCode runtime.
- Distinguish provider discovery, configured/connected status, model availability, and an actual successful model response.
- Let users explicitly test a selected provider/model. Explain that a test may consume a small amount of quota.
- Classify common failures into actionable guidance: missing credentials, rejected credentials, permission/model access, unavailable model, quota/billing, unreachable endpoint, and runtime connection errors.
- Never display or log credentials. Keep secrets in the runtime's supported credential store.
- Keep the provider documentation link as a fallback, not the primary readiness mechanism.
- Provide refresh/retry behavior and an honest state when the runtime API shape is unsupported or unavailable.

**Acceptance criteria**
- First-run screen reports real runtime results, not hard-coded provider status.
- A connected provider with available models is shown with model IDs/names.
- A user can test one model and sees a success/failure result tied to that exact provider/model.
- No configured provider, no models, invalid credentials, and offline runtime produce different guidance.
- The test is opt-in and never silently sends a generation request.
- Tests cover response normalization and error classification.

## Workstream B — Trustworthy task execution and verification

**Goal:** Make “done” mean observable evidence, not just an agent's claim.

- Standardize task acceptance criteria across single-agent and parallel-agent workflows.
- Capture changed-file summaries, verification commands, exit status, and observed output where available.
- Distinguish “agent responded,” “changes produced,” “checks passed,” “checks failed,” and “checks not run.”
- Preserve a review step before integrating isolated worktree changes.
- Make repair loops bounded: retry only with concrete failure evidence, cap attempts, preserve task scope, and stop with a clear diagnosis.
- Add tests for missing evidence, failed commands, partial success, and cancellation.

**Acceptance criteria**
- No UI labels a task as verified unless the corresponding check result is recorded as passed.
- Missing checks are shown as skipped/not run, not green.
- Repair attempts include the relevant failure evidence and cannot silently broaden the task.
- Review surfaces show acceptance criteria, changed files, and verification status together.

## Workstream C — Multi-agent orchestration and safe parallel work

**Goal:** Make the architecture's orchestrator/worker model dependable before increasing concurrency.

- Define a typed task contract: stable ID, scope, target files, dependencies, acceptance criteria, agent hint, and verification requirements.
- Validate planner output before starting workers; reject malformed, duplicate, empty, or contradictory tasks.
- Build a dependency-aware scheduler with bounded concurrency, cancellation, timeout handling, and explicit per-task states.
- Prevent overlapping write scopes by default; require an explicit conflict strategy for intentional overlap.
- Keep worker tasks isolated, collect their diffs/results, and make integration/review explicit.
- Synthesize only from completed worker evidence; report blocked/failed workers rather than implying all tasks succeeded.
- Add deterministic unit tests for planning validation, scheduling, cancellation, and failure recovery.

**Acceptance criteria**
- Invalid plans fail before workers are launched and explain why.
- Concurrency is bounded and configurable.
- One worker failure does not erase successful outcomes or mislabel the whole run.
- Conflicting target files are detected before integration.
- Every worker outcome includes status, summary, changed files/worktree, and verification evidence where available.

## Workstream D — OmniRoute and local-model interoperability

**Goal:** Integrate the local gateway as a first-class optional route without making it a hidden dependency.

- Centralize runtime/gateway settings and validate endpoints instead of relying on scattered constants.
- Probe gateway health and model discovery with timeouts; distinguish “gateway unavailable” from “gateway reachable but no usable models.”
- Show the selected route/model and any fallback behavior to the user.
- Add opt-in routing strategies only after documenting their trade-offs; do not promise token savings or latency improvements without measurements.
- Make local-model errors diagnosable and keep a last-known-good model inventory when discovery temporarily fails, if the runtime supports it.
- Add integration tests against a stub gateway for health, empty models, malformed responses, timeout, and recovery.

**Acceptance criteria**
- Axiom works with ordinary configured OpenCode providers even when OmniRoute is absent.
- Gateway status and selected route are observable.
- Fallback is explicit, bounded, and never silently changes privacy expectations.
- Telemetry uses measured values and labels estimates as estimates.

## Workstream E — Local error recovery

**Goal:** Recover from common development failures without unsafe autonomous edits.

- Normalize runtime, provider, model, tool, permission, and verification errors into structured categories.
- Attach a specific next action to each category and expose retry only when retry is meaningful.
- Allow automatic repair only for bounded, reversible cases with a concrete failing command/output.
- Require user review for broad changes, permission escalation, destructive operations, or repeated repair failure.
- Record a compact, redacted diagnostic summary; never include secrets or unfiltered environment values.

**Acceptance criteria**
- Every known error category has a targeted recovery message and a fallback path.
- Retry actions are disabled while an identical request is in flight.
- Repair has a configurable attempt limit and a visible audit trail.
- Logs redact likely credentials and do not dump environment variables.

## Workstream F — Project context and memory

**Goal:** Give agents useful, bounded project context without overwhelming the prompt or persisting secrets.

- Build/update a project context index for file layout, package scripts, key configs, and project conventions.
- Track freshness and invalidate context when relevant files change.
- Pack context by task relevance and token budget; expose estimates as estimates.
- Separate user-approved durable project notes from transient session context.
- Make project memory inspectable, editable, and clearable.
- Exclude secrets, credentials, ignored files, and large generated/vendor directories by default.

**Acceptance criteria**
- Context records identify their source and freshness.
- Prompt packing is bounded and deterministic for a fixed input.
- Users can inspect and clear persisted project notes.
- Secret-like values and ignored/generated files are excluded by default.

## Workstream G — Verification, release quality, and diagnostics

**Goal:** Make every upgrade reproducible and every desktop release diagnosable.

- Add automated unit/component tests for provider readiness, recovery classification, plan validation, and verification state.
- Run typecheck/build/test suites in CI and preserve readable failure output.
- Add desktop smoke coverage for launch, runtime startup, project selection, model readiness, first task, diff review, and clean shutdown.
- Produce a release checklist and machine-readable build metadata (version, commit, platform, runtime version).
- Ensure troubleshooting instructions cover runtime startup, provider access, local gateway, permissions, and log locations.
- Clearly label manual tests that were not run; do not claim Windows/macOS/Linux smoke validation from CI alone.

**Acceptance criteria**
- CI gates merge/release on required checks.
- Desktop packaging succeeds for supported platforms or clearly records platform limitations.
- Release notes identify the tested commit and checks performed.
- A clean install can be diagnosed without exposing credentials.

## Workstream H — Extension/plugin safety and future capability

**Goal:** Keep extension points modular while treating executable integrations as untrusted.

- Formalize plugin manifest schema, versioning, permissions, and compatibility.
- Default to least privilege and deny unknown capabilities.
- Keep plugins isolated from the main process and prevent arbitrary downloads/exec from catalog metadata.
- Add audit surfaces for requested permissions, publisher/source, and enabled state.
- Define a stable hook API for filesystem, shell, verification, and orchestration integrations only after permission boundaries are tested.

**Acceptance criteria**
- Invalid or untrusted manifests cannot execute.
- Plugin capabilities are explicit and user-visible.
- File/shell access is scoped, auditable, and testable.
- A disabled plugin has no active side effects.

## Cross-cutting requirements

- **Standalone desktop first:** core workflows do not require VS Code or another editor host.
- **Security:** no secrets in prompts, logs, plans, telemetry, or source control; validate all IPC messages and external URLs.
- **Honest status:** distinguish observed facts, estimates, agent claims, and checks actually run.
- **Accessibility:** keyboard support, focus visibility, semantic status announcements, and usable narrow layouts.
- **Resilience:** timeouts, cancellation, retries with caps, and actionable offline states.
- **Compatibility:** preserve existing projects/configuration where possible and document any migration.
- **Observability:** structured, redacted logs with correlation IDs for a task and its subtasks.
- **Performance:** avoid blocking the UI thread; make discovery cancellable and avoid redundant polling.

## One coordinated implementation wave

Work can proceed in parallel once shared interfaces are agreed. The intent is to plan and implement these areas together, while still respecting technical dependencies inside the same delivery:

1. **Contract pass:** define shared provider-readiness, task outcome, verification, recovery, and plugin-manifest types; inventory existing code and mark which blueprint capabilities already exist.
2. **Parallel build streams:** A (provider setup), B/G (verification and CI), C (orchestration), D/E (routing and recovery), F (context/memory), H (plugin safety). Keep file ownership clear and avoid multiple streams editing the same core files concurrently.
3. **Integration pass:** wire UI and runtime APIs together; reconcile contracts; remove duplicate error/status models; ensure fallback behavior is explicit.
4. **Automated gate:** run formatting/lint/typecheck/build/unit tests and targeted integration tests; fix failures before packaging.
5. **Desktop acceptance pass:** validate packaged app launch, runtime lifecycle, provider discovery, opt-in model test, first task, diff review, restart/recovery, and shutdown on supported OSes. Record unrun manual checks honestly.
6. **Release pass:** update user docs/troubleshooting, changelog, build metadata, and release artifact; publish only after the acceptance gate passes.

This is one coordinated program, not a promise that unrelated changes can be safely merged without integration. Parallelize implementation, but keep shared contracts and the final integration gate mandatory.

## Suggested delivery definition

The upgrade program is ready when a clean install can: open a project; show provider/model readiness; run a user-triggered model test; complete a small task; show acceptance criteria and real verification evidence; recover from a common provider/runtime failure; review changes before integration; and shut down cleanly. Advanced orchestration, OmniRoute routing, project context, and plugin capabilities must be feature-tested and explicitly reported as available or not yet supported.


## Implementation log

### Batch 1 — execution safety and honest verification

Implemented on `axiom/product-rebuild`:
- Recovery diagnostics now redact common API-key, bearer-token, GitHub-token, and credential-bearing URL patterns before display.
- Recovery guidance more explicitly distinguishes authentication, model availability, quota/billing, rate limits, connectivity, timeouts, permissions, and potentially side-effecting tool failures.
- Provider-readiness load/test failures pass through diagnostic redaction before rendering in the UI.
- Planner task parsing now rejects missing/empty acceptance criteria instead of silently inventing a generic criterion.
- Parallel task scheduling now treats parent-directory and child-file write scopes as overlapping, not only exact file-name matches.
- Quality-gate evaluation requires at least one check and explicit `state: passed` plus `exitCode: 0`; an agent-supplied green label alone is not verification evidence.
- Added regression tests for diagnostic redaction, recovery categories, planner acceptance criteria, nested path conflicts, missing verification evidence, and empty check sets.

Relevant commits:
- `1b0baa926fffd8cb2cb00d0e1fc814a4c720bd7a` — recovery classification and redaction
- `a2b1da175720b2d8dfce038684605f7efba7fb38` — recovery regression tests
- `1077dad39512bdda7e9b5485b8ea4eb07cce5899` — planner criteria and conflict detection
- `5aa71b9732b90c1e5a56e5d3379573237477eaa7` — planner regression tests
- `f436d8ca1a37263ed0db19e7f429afd9c37b640a` — provider diagnostic redaction
- `38750be45cbf56c78d5c78e587e3df0fe9eaa4b1` — planner/path regression tests
- `f259e9476c20130b3870fc4246dad4df25bd8229` and `03056d7842d0bacbf48bc9e7893ff72c8914519e` — strict verification evidence
- `bdadeadba381a13704f478e80cd079fa91ec97c9` and `cb48682748cee82b7df652ec29e5e1ec100175db` — quality-gate regression tests

### Batch 2 — plugin trust boundaries

Implemented on `axiom/product-rebuild`:
- Plugin manifest review now fails closed when the manifest is absent/malformed, version/publisher/description are missing, permissions are missing, or an unknown capability is requested.
- Sensitive plugin permissions continue to require explicit approval.
- Plugin source URLs must be HTTPS and cannot embed URL credentials.
- Added regression coverage for malformed manifests and unknown capabilities.

Relevant commits:
- `5476ebee4ea9ca46d839a9a80e8ec96d399180ed` — fail-closed manifest validation
- `38a61f1d9914c5bc51a1bef424b0b1dedd856295` — HTTPS/credential warning compatibility
- `8c08646159b816f1779d66c458bf04bc95f2f792` — plugin manifest regression tests

### Batch 3 — orchestration, routing, and project context

Implemented on `axiom/product-rebuild`:
- Parallel execution now preserves successful peer results when a worker fails, carries failure details forward, and reports dependent tasks blocked by failed prerequisites.
- Added per-task timeouts and caller cancellation signals; runners receive an abort signal and the scheduler stops waiting when cancellation is requested. Runners that ignore abort may still continue externally, so integrations must honor the signal.
- Added regression tests for partial success, blocked dependencies, timeouts, and cancellation.
- Added an OmniRoute `GET /models` discovery/health probe with timeout handling and distinct unreachable, unexpected-format, and empty-inventory results.
- Added an explicit fallback-selection helper. It never silently changes models: a fallback is used only when explicitly configured and present in the discovered inventory, and the result reports that it was used.
- Added project-context filtering for stale records, common generated/ignored paths, explicitly excluded paths, and common credential/private-key patterns. Exclusions carry reasons so callers can explain why context was omitted.
- Added regression tests for routing discovery/fallback and context filtering.

Relevant commits:
- `908e567259f1479276dd6528a8b4969ec53448db`, `919bed45ccd1aaa1d3a55bb1d377268316ebb1f5`, `42373289448726989000bece2208576737043b9e`, `3d51d51450824768d959cf992242ecbc1a7cb8df`, `7452fd3fd7a4e1cce865b1af13a7fcd908c26855` — orchestration failure preservation, cancellation, timeouts, tests
- `24f19d351a7be0f67b4c96115a4dc602c65bbdee`, `37c99f8b41bd22ee835103d6543335a030fc9d5a` — OmniRoute discovery and explicit fallback tests
- `be758b9aec207653c90b0451860b55d723bb9dcf`, `b46d8df1b78ad889510f687354c8a522233a5a12` — context filtering and regression tests

### Remaining integration gate

This batch has been committed to the working branch, but automated CI results have not yet been confirmed in this log. The next coordinated batches must integrate outcome-preserving orchestration, explicit cancellation/timeouts, OmniRoute health/fallback reporting, project-context freshness and exclusions, and plugin permission boundaries. Do not publish a release or mark the full program complete until CI and packaged desktop acceptance criteria have been checked. Manual desktop smoke testing remains a separate, explicitly tracked step.
