import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { hostBridge } from "../utils/hostBridge";
import { runBoundedRepair, type RepairControllerResult } from "../../shared/repairController";

type ChangedFile = { status: string; path: string };
type Check = { name: string; command?: string; state: string; exitCode?: number; output?: string };
type Review = { ok: boolean; loading?: boolean; error?: string; changedFiles?: ChangedFile[]; patch?: string; whitespaceCheck?: { passed: boolean; output: string } };
type Gate = { loading?: boolean; status?: string; checks?: Check[]; error?: string };
type Apply = { loading?: boolean; ok: boolean; error?: string; appliedPaths?: string[] };

export function WorktreeReviewPanel(props: { taskId: string; worktreePath: string; workspaceRoot?: string; acceptanceCriteria?: string[]; onRepair?: (failure: string, signal?: AbortSignal) => Promise<void> | void }) {
  const [review, setReview] = createSignal<Review | null>(null);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [gate, setGate] = createSignal<Gate | null>(null);
  const [applyResult, setApplyResult] = createSignal<Apply | null>(null);
  const [repairAttempts, setRepairAttempts] = createSignal(0);
  const [repairing, setRepairing] = createSignal(false);
  const [repairController, setRepairController] = createSignal<AbortController | null>(null);
  const [repairResult, setRepairResult] = createSignal<RepairControllerResult | null>(null);
  const [forceAcknowledged, setForceAcknowledged] = createSignal(false);
  const changedPaths = createMemo(() => (review()?.changedFiles ?? []).map(file => file.path));
  const [criteriaEvidence, setCriteriaEvidence] = createSignal<Record<string, string>>({});
  const criteriaComplete = createMemo(() => (props.acceptanceCriteria ?? []).length === 0 || (props.acceptanceCriteria ?? []).every(item => (criteriaEvidence()[item] ?? "").trim().length > 0));
  const effectiveStatus = createMemo(() => gate()?.status === "Ready to review" && !criteriaComplete() ? "Needs fixes" : gate()?.status);

  const inspect = () => {
    if (!props.workspaceRoot) return;
    setReview({ ok: false, loading: true });
    hostBridge.postMessage({ type: "inspect-agent-worktree", taskId: props.taskId, worktreePath: props.worktreePath, workspaceRoot: props.workspaceRoot });
  };
  const runGate = () => {
    if (!props.workspaceRoot || !changedPaths().length) return;
    setForceAcknowledged(false);
    setGate({ loading: true });
    hostBridge.postMessage({ type: "run-agent-quality-gate", taskId: props.taskId, worktreePath: props.worktreePath, workspaceRoot: props.workspaceRoot, changedPaths: changedPaths() });
  };

  const runGateAndWait = (signal: AbortSignal): Promise<Gate> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Repair cancelled before verification."));
    const requestId = crypto.randomUUID();
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", listener);
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true; cleanup(); callback();
    };
    const listener = (event: MessageEvent) => {
      const data = event.data as { type?: string; taskId?: string; requestId?: string; status?: string; checks?: Check[]; error?: string };
      if (data?.type !== "agent-quality-gate-result" || data.taskId !== props.taskId || data.requestId !== requestId) return;
      const result: Gate = { loading: false, status: data.status, checks: data.checks ?? [], error: data.error };
      setGate(result);
      finish(() => resolve(result));
    };
    const abort = () => finish(() => reject(new Error("Repair cancelled while verification was running.")));
    const timeout = setTimeout(() => finish(() => reject(new Error("Verification did not return within eight minutes."))), 8 * 60 * 1000);
    window.addEventListener("message", listener);
    signal.addEventListener("abort", abort, { once: true });
    setGate({ loading: true });
    hostBridge.postMessage({
      type: "run-agent-quality-gate", taskId: props.taskId, requestId,
      worktreePath: props.worktreePath, workspaceRoot: props.workspaceRoot,
      changedPaths: changedPaths(),
    });
  });

  const applySelected = (forceIntegration = false) => {
    if (!props.workspaceRoot || !selected().length) return;
    if (!forceIntegration && effectiveStatus() !== "Ready to review") return;
    if (forceIntegration && (!forceAcknowledged() || !gate() || gate()?.loading)) return;
    if (forceIntegration && !window.confirm("Force integration despite failed or incomplete quality checks? Axiom will still refuse dirty destination files, remote drift, unsafe paths, and file conflicts. Continue?")) return;
    setApplyResult({ loading: true, ok: false });
    hostBridge.postMessage({ type: "apply-agent-worktree-changes", taskId: props.taskId, worktreePath: props.worktreePath, workspaceRoot: props.workspaceRoot, paths: selected(), forceIntegration });
  };
  const toggle = (path: string, checked: boolean) => setSelected(old => checked ? [...new Set([...old, path])] : old.filter(item => item !== path));

  onMount(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data as { type?: string; taskId?: string; ok?: boolean; error?: string; changedFiles?: ChangedFile[]; patch?: string; whitespaceCheck?: Review["whitespaceCheck"]; status?: string; checks?: Check[]; appliedPaths?: string[] };
      if (data?.taskId !== props.taskId) return;
      if (data.type === "agent-worktree-review-result") {
        const files = data.changedFiles ?? [];
        setReview({ ok: data.ok === true, loading: false, error: data.error, changedFiles: files, patch: data.patch ?? "", whitespaceCheck: data.whitespaceCheck });
        setSelected(files.map(file => file.path));
        setGate(null);
        setApplyResult(null);
      } else if (data.type === "agent-quality-gate-result") {
        setGate({ loading: false, status: data.status, checks: data.checks, error: data.error });
      } else if (data.type === "agent-worktree-apply-result") {
        setApplyResult({ loading: false, ok: data.ok === true, error: data.error, appliedPaths: data.appliedPaths });
        if (data.ok) inspect();
      }
    };
    window.addEventListener("message", listener);
    onCleanup(() => window.removeEventListener("message", listener));
  });

  return <div class="workflow-plan__parallel">
    <p>Isolated worktree: <code>{props.worktreePath}</code></p>
    <div class="workflow-plan__actions">
      <button class="workflow-plan__secondary" disabled={!props.workspaceRoot || review()?.loading} onClick={inspect}>
        {review()?.loading ? "Inspecting diff…" : review()?.ok ? "Refresh actual diff" : "Inspect actual diff"}
      </button>
      <button class="workflow-plan__secondary" disabled={!review()?.ok || !changedPaths().length || gate()?.loading} onClick={runGate}>
        {gate()?.loading ? "Running checks…" : "Run quality gate"}
      </button>
    </div>
    <p class="worktree-review__note">Quality-gate commands are detected from project manifests and lockfiles (JavaScript/TypeScript, Rust, Python, and Android). Environment-specific Android checks are suggestions rather than automatic commands.</p>
    <Show when={review()} keyed>{item => <div>
      <strong>{item.ok ? "Actual worktree diff" : "Inspection needs attention"}</strong>
      <Show when={item.error}><p>{item.error}</p></Show>
      <Show when={item.ok}>
        <p>{item.changedFiles?.length ?? 0} tracked changed files · whitespace check {item.whitespaceCheck?.passed ? "passed" : "needs attention"}</p>
        <Show when={(item.changedFiles?.length ?? 0) > 0}>
        <Show when={(props.acceptanceCriteria ?? []).length > 0}>
          <strong>Acceptance criteria</strong>
          <p>Record the evidence you reviewed for each criterion. A criterion remains outstanding until its evidence note is provided.</p>
          <For each={props.acceptanceCriteria}>{criterion => <label class="worktree-review__file">
            <span>{criterion}</span>
            <textarea
              aria-label={"Evidence for: " + criterion}
              value={criteriaEvidence()[criterion] ?? ""}
              placeholder="Reference the changed file, diff, test, or observed behavior…"
              rows={2}
              onInput={event => setCriteriaEvidence(old => ({ ...old, [criterion]: event.currentTarget.value }))}
            />
          </label>}</For>
          <Show when={!criteriaComplete()}><p class="worktree-review__note">Outstanding criteria: {(props.acceptanceCriteria ?? []).filter(item => !(criteriaEvidence()[item] ?? "").trim()).length}</p></Show>
        </Show>
          <p>Select files to integrate after reviewing the diff and quality-gate evidence:</p>
          <For each={item.changedFiles}>{file => <label class="worktree-review__file">
            <input type="checkbox" checked={selected().includes(file.path)} onChange={event => toggle(file.path, event.currentTarget.checked)} />
            <code>{file.status}</code> {file.path}
          </label>}</For>
          <details><summary>View actual Git diff</summary><pre>{item.patch || "No tracked patch returned."}</pre></details>
        </Show>
        <Show when={(item.changedFiles?.length ?? 0) === 0}><p>No tracked changes against the worktree HEAD. Untracked files are listed separately only when supported by the host.</p></Show>
      </Show>
    </div>}</Show>
    <Show when={gate()} keyed>{result => <div class="workflow-plan__parallel">
      <strong>Quality gate: {effectiveStatus() ?? (result.loading ? "Running" : "Blocked")}</strong>
      <Show when={result.error}><p>{result.error}</p></Show>
      <For each={result.checks}>{check => <div class="worktree-review__check">
        <span>{check.state === "passed" ? "✓" : check.state === "failed" ? "✕" : "◌"} {check.name} · {check.state}</span>
        <Show when={check.output}><details><summary>Output</summary><pre>{check.output}</pre></details></Show>
      </div>}</For>
      <Show when={result.status === "Needs fixes" && (result.checks ?? []).some(check => check.state === "failed") && props.onRepair && repairAttempts() < 2}>
        <button class="workflow-plan__secondary" disabled={repairing()} onClick={async () => {
          if (!props.onRepair) return;
          const controller = new AbortController();
          setRepairController(controller);
          setRepairing(true);
          setRepairResult(null);
          setRepairAttempts(0);
          try {
            const recovery = await runBoundedRepair({
              maxAttempts: 2,
              maxDurationMs: 10 * 60 * 1000,
              signal: controller.signal,
              verify: async signal => {
                const verified = await runGateAndWait(signal);
                const failures = (verified.checks ?? []).filter(check => check.state === "failed" && check.command && Number.isInteger(check.exitCode) && check.exitCode !== 0);
                if (verified.status === "Ready to review" && (verified.checks ?? []).every(check => check.state === "passed")) {
                  return { status: "passed", command: "Axiom worktree quality gate", exitCode: 0, output: "All required worktree checks passed." };
                }
                if (failures.length) {
                  const failure = failures[0];
                  return { status: "failed", command: failure.command, exitCode: failure.exitCode, label: failure.name, output: failure.output || "The check failed without captured output." };
                }
                return { status: "unverified", output: verified.error || "Quality gate did not provide a concrete failing command and exit code." };
              },
              repair: async (failure, attempt, signal) => {
                if (signal.aborted) throw new Error("Repair cancelled.");
                await props.onRepair?.(
                  "Repair attempt " + attempt + ". Failing command: " + failure.command + "\nExit code: " + failure.exitCode + "\nCheck: " + (failure.label || "Verification") + "\n\n" + (failure.output || ""),
                  signal,
                );
                return "Task agent received the exact failing verification evidence.";
              },
              onAttempt: record => setRepairAttempts(record.attempt),
            });
            setRepairResult(recovery);
            if (recovery.status === "passed") setGate(current => current ? { ...current, status: "Ready to review" } : current);
          } catch (error) {
            setRepairResult({
              status: controller.signal.aborted ? "cancelled" : "failed",
              attempts: [], finalEvidence: { status: "unverified", output: error instanceof Error ? error.message : String(error) },
              reason: error instanceof Error ? error.message : "Repair failed.",
            });
          } finally {
            setRepairController(null);
            setRepairing(false);
          }
        }}>{repairing() ? "Repairing and re-verifying…" : "Run bounded repair (up to 2 attempts)"}</button>
        <Show when={repairing()}>
          <button class="workflow-plan__secondary" onClick={() => repairController()?.abort()}>Cancel repair</button>
          <p>Attempt {repairAttempts()} of 2 · repair time budget: 10 minutes</p>
        </Show>
        <Show when={repairResult()}>
          <p class="worktree-review__note">Repair outcome: {repairResult()!.status} — {repairResult()!.reason}</p>
        </Show>
      </Show>
      <button class="workflow-plan__secondary" disabled={effectiveStatus() !== "Ready to review" || !selected().length || applyResult()?.loading} onClick={() => applySelected(false)}>
        {applyResult()?.loading ? "Integrating…" : "Integrate selected files"}
      </button>
      <Show when={!!gate() && !gate()?.loading && effectiveStatus() !== "Ready to review"}>
        <label class="worktree-review__file">
          <input type="checkbox" checked={forceAcknowledged()} onChange={event => setForceAcknowledged(event.currentTarget.checked)} />
          I reviewed the diff and accept the risk of bypassing failed or incomplete quality checks.
        </label>
        <button class="workflow-plan__secondary" disabled={!forceAcknowledged() || !selected().length || applyResult()?.loading} onClick={() => applySelected(true)}>
          {applyResult()?.loading ? "Integrating…" : "Force integrate selected files…"}
        </button>
      </Show>
      <p class="worktree-review__note">Force integration bypasses the quality-gate status only. Dirty destination files, remote drift, unsafe paths, symlinks, and transactional rollback protections remain enforced. Repair is limited to one attempt per task review.</p>
    </div>}</Show>
    <Show when={applyResult()} keyed>{result => <p>{result.ok ? "Integrated: " + (result.appliedPaths ?? []).join(", ") : result.error ? "Integration blocked: " + result.error : ""}</p>}</Show>
  </div>;
}
