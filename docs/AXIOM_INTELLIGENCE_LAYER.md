# Axiom intelligence layer

This layer adds deterministic policy helpers and lightweight UI entry points for coordinated agent work. It complements the existing OmniRoute planner and OpenCode child-session runner; it does not replace the runtime that actually executes tasks.

## 1. Agent orchestration

- `coordinateTasks` normalizes declared workspace-relative paths, assigns a specialist role (research, implementation, debugging, testing, or review), and rejects duplicate task IDs.
- Existing `createIndependentTasks` / `executeTaskBatches` remain responsible for dependency validation, overlapping-target scheduling, and bounded-by-dependency execution batches.
- These roles are task metadata and routing hints. They do not guarantee that a particular model/agent is installed or that child agents are isolated from the shared workspace.

## 2. Context optimization

- `packContext` deduplicates items by ID, prefers constraints and decisions, then open tasks, errors, files, conversation, and raw tool output.
- The packer respects a caller-supplied token budget using a rough characters-per-token estimate. The returned count is explicitly an estimate, not a provider-reported token count or proof of savings.
- Callers should preserve important constraints, decisions, errors, and open tasks as separate items; the helper does not automatically extract facts from raw conversation history.

## 3. Reusable combos

The starter combos are **Fix it** (diagnose → implement → test → summarize), **Ship it** (review → test → release notes), and **Understand it** (map architecture → explain). They are surfaced as one-tap prompt starters in the welcome and plan views. They do not silently deploy, publish, or run privileged commands.

## 4. Proactive next actions

`suggestNextActions` prioritizes diagnosing a reported failure, continuing a prepared plan, or verifying unverified changes. Suggestions are grounded in the state passed by the UI and populate the prompt for user review; they do not auto-submit prompts or replay failed commands.

## 5. Plugin ecosystem foundations

`reviewPluginManifest` validates basic plugin metadata, flags unverified publishers and non-HTTPS sources, and identifies write, command-execution, and network permissions that require approval. This is a catalog-review primitive, **not yet a plugin marketplace or installer**. The existing in-process plugin registry is not a sandbox; third-party code must not be loaded automatically or treated as safe based only on manifest metadata.

## Connected runtime behavior

- Before a child task starts, Axiom reads up to the 30 most recent parent-session messages, extracts text, and packs relevant history together with the original request, task scope, target files, plan steps, and completed dependency summaries. The context budget defaults to 4,000 estimated tokens. Low-priority material may be omitted; token counts are estimates, not provider usage measurements.
- Dependency batches receive summaries of completed tasks. Task execution emits queued/running/succeeded/failed outcomes and retains child session IDs, agent names, summaries, errors, and isolated worktree paths where available.
- The UI surfaces task status and summaries, and next-step suggestions prioritize actual failed or pending tasks. Combo prompts include the observed task ledger and tell the model not to claim unobserved checks passed.
- Child agents are launched in detached Git worktrees created from repository HEAD, under the OS temporary directory. This isolates their filesystem edits from the parent working tree. The parent then receives the worktree paths and is instructed to inspect diffs and selectively integrate changes. Uncommitted parent edits are not copied into those worktrees. Worktrees are retained for review; cleanup is currently manual.
- The built-in catalog is limited to declarative, permission-reviewed workflow packs. Unverified executable plugins are blocked from enabling. There is no arbitrary third-party code loader in this UI; full process/container sandboxing and durable cross-session installation remain future work.

## Live validation

The GitHub Actions workflow validates compilation and unit tests, including mocked OmniRoute responses and orchestration dependency/outcome behavior. It cannot reach a developer's loopback OmniRoute gateway or prove that a local OpenCode server accepts child sessions in temporary worktrees. Those live integration checks must run in the target standalone desktop app. If worktree creation or child-session creation is rejected by the local server, the run fails with an explicit error rather than silently falling back to shared-workspace execution.

## Validation boundary

Unit tests cover role inference, task ID/path checks, context-budget behavior, combos, suggestions, and plugin manifest review. GitHub Actions can validate these deterministic helpers and compile the UI. A green CI run does not prove live OmniRoute availability, model quality, child-agent edits, or plugin isolation.
