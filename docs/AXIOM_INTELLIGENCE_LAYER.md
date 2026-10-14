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

## Validation boundary

Unit tests cover role inference, task ID/path checks, context-budget behavior, combos, suggestions, and plugin manifest review. GitHub Actions can validate these deterministic helpers and compile the UI. A green CI run does not prove live OmniRoute availability, model quality, child-agent edits, or plugin isolation.
