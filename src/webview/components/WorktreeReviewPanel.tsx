import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { vscode } from "../utils/vscode";

type Review = {
  ok: boolean;
  loading?: boolean;
  error?: string;
  changedFiles?: Array<{ status: string; path: string }>;
  patch?: string;
  whitespaceCheck?: { passed: boolean; output: string };
};

export function WorktreeReviewPanel(props: { taskId: string; worktreePath: string; workspaceRoot?: string }) {
  const [review, setReview] = createSignal<Review | null>(null);
  const inspect = () => {
    if (!props.workspaceRoot) return;
    setReview({ ok: false, loading: true });
    vscode.postMessage({ type: "inspect-agent-worktree", taskId: props.taskId, worktreePath: props.worktreePath, workspaceRoot: props.workspaceRoot });
  };
  onMount(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data as { type?: string; taskId?: string; ok?: boolean; error?: string; changedFiles?: Array<{ status: string; path: string }>; patch?: string; whitespaceCheck?: { passed: boolean; output: string } };
      if (data?.type !== "agent-worktree-review-result" || data.taskId !== props.taskId) return;
      setReview({ ok: data.ok === true, loading: false, error: data.error, changedFiles: data.changedFiles ?? [], patch: data.patch ?? "", whitespaceCheck: data.whitespaceCheck });
    };
    window.addEventListener("message", listener);
    onCleanup(() => window.removeEventListener("message", listener));
  });
  return <div class="workflow-plan__parallel">
    <p>Isolated worktree: <code>{props.worktreePath}</code></p>
    <button class="workflow-plan__secondary" disabled={!props.workspaceRoot || review()?.loading} onClick={inspect}>
      {review()?.loading ? "Inspecting diff…" : review()?.ok ? "Refresh actual diff" : "Inspect actual diff"}
    </button>
    <Show when={review()} keyed>{item => <div>
      <strong>{item().ok ? "Actual worktree diff" : "Inspection needs attention"}</strong>
      <Show when={item().error}><p>{item().error}</p></Show>
      <Show when={item().ok}>
        <p>{item().changedFiles?.length ?? 0} changed files · whitespace check {item().whitespaceCheck?.passed ? "passed" : "needs attention"}</p>
        <For each={item().changedFiles}>{file => <p><code>{file.status}</code> {file.path}</p>}</For>
        <Show when={(item().changedFiles?.length ?? 0) > 0}>
          <details><summary>View patch</summary><pre>{item().patch || "No tracked diff returned."}</pre></details>
        </Show>
        <Show when={item().whitespaceCheck && !item().whitespaceCheck?.passed}><pre>{item().whitespaceCheck?.output}</pre></Show>
      </Show>
    </div>}</Show>
  </div>;
}
