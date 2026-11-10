# Axiom Autonomous Execution Roadmap

## Purpose

Use the product blueprint to evolve Axiom from a local, isolated project-building desktop app into an outcome-driven system that can plan, execute, repair, verify, and eventually deploy complete projects. This roadmap is an implementation contract, not a claim that future capabilities already exist.

## Guiding principles

- Keep Axiom a standalone desktop product. Do not reintroduce a VS Code extension surface or expose upstream branding in product UI.
- Build on the existing planner, worker sessions, worker-state persistence, Git worktree isolation, MCP runtime, and OmniRoute integration where they are proven to exist.
- Keep provider-specific cloud execution optional and behind explicit adapters. Do not hardcode one gateway, cloud, or model provider as a universal default.
- Treat plans and model output as untrusted input. Validate schemas, workspace paths, commands, URLs, credentials, resource limits, and allowed actions before execution.
- Make autonomy bounded and observable: durable task states, attempt limits, cancellation, timeouts, logs, test evidence, and a clear audit trail.
- A green status must mean the relevant action actually ran and passed. Infrastructure presence, generated text, or a tool being listed is not proof of execution.
- Never deploy, publish, or push changes without the configured policy and user authorization that action requires.

## Target architecture

1. **Visual Operator Workspace** — project onboarding, goal entry, plan and task graph, worker activity, diffs, verification evidence, deployment status, and intervention controls.
2. **Orchestrator** — turns a goal into schema-validated tasks with dependencies, scoped file ownership, acceptance criteria, risk classification, and budgets.
3. **Worker runtime** — runs tasks in isolated worktrees or a configured remote sandbox through a common adapter; records sessions and structured events.
4. **Tool and provider layer** — MCP integrations, OmniRoute/model routing, browser automation, source control, and deployment providers through explicit capability interfaces.
5. **Quality and repair controller** — runs required checks, classifies failures, allows bounded repair attempts, reruns affected checks, and stops safely when limits or policy gates are reached.
6. **Project memory and evidence** — project-scoped conventions and decisions, task history, test artifacts, screenshots, logs, and deployment metadata with explicit retention and privacy boundaries.

## Delivery phases

### Phase 1 — Prove the local execution loop

- [ ] Verify goal/planner output becomes a durable task plan with validated dependencies and acceptance criteria.
- [ ] Verify each planned task starts a real worker session in an isolated worktree.
- [ ] Stream structured worker lifecycle and diagnostic events into the dashboard, including failure, timeout, cancellation, and retry.
- [ ] Ensure restart/recovery is idempotent and stale attempts cannot overwrite current task state.
- [ ] Prove MCP calls from an actual worker, not just connection metadata or discovered tool IDs.
- [ ] Run the repository's desktop, web, and end-to-end test suites and record real results.

**Exit criteria:** a small real project task can be planned, executed, inspected, tested, retried after a controlled failure, and safely integrated with traceable evidence.

### Phase 2 — Bounded autonomous repair

- [ ] Convert verification output into structured failure records (command, exit code, stdout/stderr excerpt, duration, attempt).
- [ ] Add a repair controller with configurable maximum attempts, wall-clock budget, allowed command policy, and cancellation.
- [ ] Give each repair attempt a fresh or explicitly reset isolated worktree; preserve the original failure and all attempt artifacts.
- [ ] Rerun the failed check after each patch; never infer success from a model's explanation.
- [ ] Summarize the root cause, applied patch, checks rerun, and unresolved risks for the user.

**Exit criteria:** a deliberately introduced, repairable test failure is fixed within the configured budget, while an unrepairable failure terminates safely with useful evidence.

### Phase 3 — Browser and visual verification

- [ ] Add a browser-verification adapter using the repository's supported Playwright setup.
- [ ] Start the app in the task environment, wait for an explicit readiness signal, and run smoke tests against real routes and interactions.
- [ ] Capture screenshots, console errors, failed requests, and traces as task artifacts.
- [ ] Support user-provided visual references with explicit comparison criteria; do not treat a screenshot alone as proof that controls work.
- [ ] Feed browser failures into the same bounded repair controller and rerun affected checks.

**Exit criteria:** a generated web project is built, launched, exercised in a browser, and produces inspectable test artifacts.

### Phase 4 — Remote, disposable execution

- [ ] Define a sandbox provider interface before selecting or requiring a cloud vendor.
- [ ] Support capability discovery for images, languages/toolchains, CPU/memory, persistence, networking, secrets, and artifact upload.
- [ ] Provision isolated, short-lived environments from pinned images with least privilege, resource limits, and cleanup guarantees.
- [ ] Persist task state and artifacts independently from the desktop process so work can resume after app closure or connection loss.
- [ ] Add explicit remote-session lifecycle, reconnect, cancellation, expiry, and orphan cleanup.
- [ ] Keep local worktrees as a first-class fallback and development mode.

**Exit criteria:** a task can run in a remote sandbox, survive desktop disconnection, reconnect to its durable state, and clean up its resources safely.

### Phase 5 — Staging and deployment

- [ ] Add provider adapters for selected deployment platforms rather than embedding vendor-specific logic in the orchestrator.
- [ ] Validate deployment manifests, build output, domains, environment variables, and secret references before deployment.
- [ ] Require policy approval for public production changes; default new deployments to preview/staging.
- [ ] Verify the deployed URL with browser smoke tests and health checks before reporting success.
- [ ] Store deployment URL, provider job ID, revision, verification evidence, and rollback instructions.

**Exit criteria:** a verified staging deployment produces a working URL and repeatable evidence; production promotion remains controlled by explicit policy.

### Phase 6 — Cross-task project memory

- [ ] Start with a versioned, project-scoped memory contract for conventions, decisions, accepted fixes, and known failures.
- [ ] Retrieve only relevant, permission-appropriate memory and identify its source and freshness.
- [ ] Keep secrets and sensitive environment values out of memory and model context.
- [ ] Add optional encrypted sync only after authentication, tenant isolation, deletion, retention, and offline behavior are defined.
- [ ] Treat retrieved memory as advisory context, never as executable instructions or proof.

**Exit criteria:** follow-up tasks can reuse validated project knowledge without leaking context across projects or users.

## Proposed execution order

1. Finish the local planner → worker → diagnostics → dashboard proof.
2. Add structured verification evidence and a bounded repair controller.
3. Add Playwright browser verification and artifact retention.
4. Introduce the sandbox adapter and one reference provider, retaining local execution.
5. Add staging deployment adapters and verify deployed previews.
6. Add secure, project-scoped memory and optional cross-device sync.

## Non-goals and guardrails

- Do not replace working local execution with cloud-only execution before remote parity is demonstrated.
- Do not introduce unlimited repair loops, uncontrolled parallel edits, or unrestricted shell/network access.
- Do not store credentials in task plans, logs, screenshots, or project memory.
- Do not describe a task as deployed, tested, repaired, or complete unless the corresponding action ran and produced evidence.
