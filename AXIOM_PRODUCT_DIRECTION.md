# Axiom Product Direction

## Product thesis

Axiom is an AI-first app for building software through conversation. It is not another IDE and should not present source code as the primary user experience. Users describe the outcome they want; Axiom plans the work, coordinates agents and tools, implements changes, verifies the result, and explains what changed in human language.

The product may retain an optional code editor, terminal, and detailed diffs for users who want direct control. Those are power tools, not the main product identity.

## Experience principles

1. **Outcome-first:** Start with an idea, request, or project—not an empty editor.
2. **Conversation is the primary interface:** Keep project context across iterative requests.
3. **Changes as topics:** Present updates as understandable topics such as “Added sign-in and account recovery.” Each topic can reveal rationale, preview, validation results, affected files, and a detailed diff on demand.
4. **Visible agency:** Show the plan, agent activity, blockers, progress, and verification status without exposing every low-level tool call by default.
5. **Human control:** Make permissions, approvals, cancellation, undo/revert, and task state clear.
6. **Power tools stay available:** Source editing, terminal, Git, logs, and raw diffs remain accessible without dominating the default interface.
7. **Model-agnostic:** Keep provider selection and routing behind a replaceable abstraction; support local models and hosted providers where compatible.
8. **Reliable over theatrical:** Never claim a change succeeded without checking the tool result. Verify generated work and make retries bounded.

## Product pillars

- **Agent orchestration:** Plan work into tasks, delegate independent tasks to specialist agents, respect dependencies, isolate conflicting changes, integrate results, and verify the whole task.
- **Combos:** Reusable execution strategies defining planning, model routing, worker roles, concurrency, budgets, permissions, and verification.
- **Context and token efficiency:** Retrieve relevant project context, summarize completed work, reuse cached context when supported, and measure actual token/latency outcomes. Do not promise unsupported savings.
- **Local-model resilience:** Classify provider, model-server, context, tool-call, build, and test failures; recover with bounded retries, compatible fallback, clearer structured requests, or targeted repair.
- **Plugins and tools:** Extensible integrations with documented APIs, versioning, least-privilege permissions, and isolation for untrusted extensions.
- **Project understanding:** Maintain useful repository context and surface previews, project health, and meaningful change history.

## Initial implementation milestone

Deliver one end-to-end loop before expanding the feature set:

1. User starts or opens a project and describes a desired outcome.
2. Axiom proposes a concise plan.
3. The agent runtime performs edits in the project workspace.
4. Axiom runs available relevant checks and reports failures honestly.
5. The UI presents a topic-based change summary and validation status, with source diffs available on demand.
6. The user can request another iteration, inspect details, cancel work, or revert safely.

## Architecture approach

This repository is currently an OpenCode-oriented VS Code extension/webview using the OpenCode SDK. Evolve it in place and preserve useful working capabilities while validating the target architecture. Avoid a destructive cleanup until each directory and dependency has been classified as required, reusable, obsolete, or undecided.

Keep clear boundaries between:
- Product UI and presentation state
- Project/task/session persistence
- Agent planning and orchestration
- Model/provider routing
- Tool execution and permission checks
- Validation and failure recovery
- Plugin contracts and extension isolation

Do not introduce a new desktop shell or replace the runtime solely for aesthetic reasons. Make those choices only when a concrete product requirement demands them.

## Non-goals for the first milestone

- Rewriting the whole repository before a working vertical slice exists
- Building a general-purpose IDE as the main product
- Unbounded autonomous loops or unrestricted destructive actions
- Hard-coding a single model provider or assuming a local gateway always exists
- Treating token compression claims or agent parallelism as successful without measurement

## First development sequence

1. Audit the existing UI, SDK integration, scripts, tests, and dependencies.
2. Rename product-facing OpenCode branding where appropriate without breaking upstream/runtime references.
3. Design and implement the conversation-first project workspace and topic-based change feed.
4. Wire the initial end-to-end build-and-verify loop.
5. Add persistent planning and bounded agent delegation.
6. Add resilience, combos, context efficiency, and plugin APIs incrementally.
7. Remove only confirmed obsolete files and dependencies; keep the build and tests passing after each change.
