# Axiom product workflow primitives

This document describes the shared deterministic contracts for the five product upgrades. These helpers are deliberately adapter-based: they do not pretend to run commands, inspect a live worktree, persist data, or apply Git changes without the runtime supplying those observations and capabilities.

## Quality Gate

`evaluateQualityGate` consumes observed check outcomes, the actual changed-file list, expected paths, unfinished acceptance criteria, and an optional blocking reason. It returns one of **Ready to review**, **Needs fixes**, or **Blocked**. A failed/non-zero check, unverified or skipped check, unexpected path, or unfinished requirement prevents review-ready status. A blocked runtime prerequisite takes precedence.

Runtime integration contract:
1. Select checks from the project manifest and files changed (typecheck, tests, lint, build where applicable).
2. Execute checks in the relevant task worktree and preserve command, exit code, and output.
3. Read the actual Git diff and compare changed paths against the declared task scope.
4. Feed observed evidence into the gate. Do not infer success from an agent's narrative.
5. For failed checks, pass the actual failure output to the responsible task and retry only within a configured bound. Keep the result Needs fixes or Blocked if the retry budget expires.

## Adaptive Task Planner

`validateTaskPlan` validates scoped tasks, workspace-relative target paths, unique IDs, dependency references, cycles, and explicit acceptance criteria. `replanAfterOutcomes` preserves successful work, marks descendants of failed/blocked tasks as blocked, and returns unrelated tasks for replanning. Agent assignment remains a hint, not a guarantee that a model is installed.

## Smart Change Review

`reviewTaskResults` creates task-level review records with summaries, changed paths, quality status, and a pending decision. `selectIntegrationChanges` creates an integration manifest for explicitly accepted tasks and reports path collisions. It does not execute Git or write files. A runtime adapter must apply selected changes with a safe patch/worktree strategy and preserve unrelated dirty paths. Never apply a task whose quality gate is not Ready to review.

## Persistent Project Intelligence

`ProjectMemoryStore` is the persistence boundary. `rememberProjectFact`, `retrieveProjectMemories`, and `forgetProjectMemory` implement upsert, lightweight relevance ranking, and deletion through an injected store. This module intentionally does not silently choose a storage location. A runtime adapter must scope memories to a project, expose inspect/edit/delete UI, and avoid storing secrets or unrelated personal data.

## Outcome-Centered Build Experience

`summarizeBuildOutcome` produces a compact outcome summary: completed and outstanding requirements, unique changed paths, passed and outstanding checks, optional preview URL, and suggested next steps. It reports missing verification as outstanding rather than claiming success.

## Current integration boundary

The shared contracts and deterministic tests are implemented in `src/shared/axiomWorkflow.ts`. They are a foundation, not a claim that all five features are already wired end-to-end in the VS Code UI. Live worktree inspection, bounded repair execution, safe patch application, durable storage, screenshot capture, and the corresponding interactive UI require runtime adapters and UI wiring. CI can verify the deterministic contracts; it cannot prove a local OmniRoute/OpenCode session behaves correctly.
