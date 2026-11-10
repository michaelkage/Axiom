import { createSignal, onCleanup, onMount, For, Show } from "solid-js";

type TerminalOutput = { requestId: string; stream: "stdout" | "stderr"; text: string };
const MAX_TERMINAL_OUTPUT_CHARS = 120_000;
const MAX_TERMINAL_OUTPUT_ENTRIES = 1_000;

type TerminalBridge = {
  run: (request: { requestId: string; command: string; cwd: string }) => Promise<{ exitCode: number; cwd: string }>;
  cancel: (requestId: string) => Promise<boolean>;
  onOutput: (callback: (chunk: TerminalOutput) => void) => () => void;
};

export function TerminalPanel() {
  const [expanded, setExpanded] = createSignal(false);
  const [command, setCommand] = createSignal("");
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [draftCommand, setDraftCommand] = createSignal("");
  const [cwd, setCwd] = createSignal("");
  const [running, setRunning] = createSignal<string | null>(null);
  const [output, setOutput] = createSignal<Array<{ kind: string; text: string }>>([
    { kind: "system", text: "Project terminal · commands run inside the selected project folder." }
  ]);
  const bridge = (window as unknown as { axiomDesktop?: { terminal?: TerminalBridge } }).axiomDesktop?.terminal;

  const append = (kind: string, text: string) => {
    setOutput(previous => {
      const next = [...previous, { kind, text: text.slice(-MAX_TERMINAL_OUTPUT_CHARS) }];
      let total = next.reduce((size, item) => size + item.text.length, 0);
      // Bound both retained text and DOM node count. A process that emits thousands
      // of tiny chunks should not turn the terminal into thousands of rendered spans.
      while ((total > MAX_TERMINAL_OUTPUT_CHARS || next.length > MAX_TERMINAL_OUTPUT_ENTRIES) && next.length > 1) {
        const removed = next.shift();
        total -= removed?.text.length ?? 0;
      }
      if (next.length === 1 && total > MAX_TERMINAL_OUTPUT_CHARS) {
        next[0] = { ...next[0], text: next[0].text.slice(-MAX_TERMINAL_OUTPUT_CHARS) };
      }
      return next;
    });
  };

  const clearOutput = () => setOutput([{ kind: "system", text: "Terminal output cleared." }]);

  const handleCommandKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      clearOutput();
      return;
    }
    if (event.key === "ArrowUp" && !running() && history().length > 0) {
      event.preventDefault();
      if (historyIndex() === -1) setDraftCommand(command());
      const next = historyIndex() === -1 ? history().length - 1 : Math.max(0, historyIndex() - 1);
      setHistoryIndex(next);
      setCommand(history()[next] ?? "");
    } else if (event.key === "ArrowDown" && !running() && historyIndex() !== -1) {
      event.preventDefault();
      if (historyIndex() >= history().length - 1) {
        setHistoryIndex(-1);
        setCommand(draftCommand());
      } else {
        const next = historyIndex() + 1;
        setHistoryIndex(next);
        setCommand(history()[next] ?? "");
      }
    }
  };

  onMount(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onOutput(chunk => {
      if (chunk.requestId === running()) append(chunk.stream, chunk.text);
    });
    onCleanup(unsubscribe);
  });

  const execute = async (event: SubmitEvent) => {
    event.preventDefault();
    const text = command().trim();
    if (!text || running()) return;
    if (!bridge) {
      append("stderr", "The integrated terminal is only available in the Axiom desktop app.");
      return;
    }
    const requestId = crypto.randomUUID().replace(/-/g, "");
    setRunning(requestId);
    setHistory(previous => [...previous.filter(item => item !== text), text].slice(-100));
    setHistoryIndex(-1);
    setDraftCommand("");
    append("command", "$ " + text);
    setCommand("");
    try {
      const result = await bridge.run({ requestId, command: text, cwd: cwd().trim() });
      append(result.exitCode === 0 ? "system" : "stderr", "Process exited with code " + result.exitCode + ".");
    } catch (error) {
      append("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(null);
    }
  };

  const cancel = async () => {
    const id = running();
    if (!id || !bridge) return;
    try { await bridge.cancel(id); } catch (error) {
      append("stderr", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section class="axiom-terminal" style={{ "margin": "10px 20px", "border": "1px solid #30323b", "border-radius": "10px", "background": "#111319", "color": "#e5e7eb", "overflow": "hidden" }} aria-label="Integrated terminal">
      <div style={{ display: "flex", "align-items": "center", gap: "10px", padding: "10px 12px" }}>
        <strong style={{ "font-size": "12px", "letter-spacing": ".08em" }}>TERMINAL</strong>
        <span style={{ color: "#8b93a7", "font-size": "12px" }}>Project-scoped shell</span>
        <span style={{ flex: "1" }} />
        <Show when={running()}><button type="button" onClick={() => void cancel()} style={{ padding: "5px 9px" }}>Stop command</button></Show>
        <button type="button" onClick={() => setExpanded(value => !value)} style={{ padding: "5px 9px" }}>{expanded() ? "Hide terminal" : "Open terminal"}</button>
      </div>
      <Show when={expanded()}>
        <div style={{ padding: "0 12px 12px" }}>
          <div style={{ display: "flex", gap: "8px", "margin-bottom": "8px", "flex-wrap": "wrap" }}>
            <label style={{ display: "flex", "align-items": "center", gap: "6px", "font-size": "12px", color: "#9ca3af" }}>
              Working directory
              <input aria-label="Terminal working directory" value={cwd()} onInput={event => setCwd(event.currentTarget.value)} placeholder="project root" disabled={!!running()} style={{ width: "220px", padding: "7px", background: "#1b1e27", color: "#e5e7eb", border: "1px solid #383b47", "border-radius": "5px" }} />
            </label>
            <button type="button" onClick={clearOutput} style={{ padding: "5px 9px" }}>Clear output</button>
          </div>
          <pre role="log" aria-live="polite" style={{ margin: "0 0 10px", padding: "12px", height: "210px", overflow: "auto", background: "#090a0e", border: "1px solid #252833", "border-radius": "6px", "white-space": "pre-wrap", "overflow-wrap": "anywhere", "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace", "font-size": "12px", "line-height": "1.55" }}>
            <For each={output()}>{item => <span style={{ color: item.kind === "stderr" ? "#fca5a5" : item.kind === "command" ? "#93c5fd" : item.kind === "system" ? "#9ca3af" : "#e5e7eb" }}>{item.text}{item.text.endsWith("\n") ? "" : "\n"}</span>}</For>
          </pre>
          <form onSubmit={execute} style={{ display: "flex", gap: "8px" }}>
            <input aria-label="Terminal command" value={command()} onInput={event => { setCommand(event.currentTarget.value); if (historyIndex() === -1) setDraftCommand(event.currentTarget.value); }} onKeyDown={handleCommandKeyDown} placeholder="Run a command, e.g. npm test" disabled={!!running()} style={{ flex: "1", "min-width": "0", padding: "10px", background: "#1b1e27", color: "#e5e7eb", border: "1px solid #383b47", "border-radius": "6px", "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
            <button type="submit" disabled={!!running() || !command().trim()} style={{ padding: "8px 14px" }}>{running() ? "Running…" : "Run"}</button>
          </form>
          <small style={{ display: "block", color: "#8b93a7", "margin-top": "7px" }}>Commands execute with your user permissions. Up/Down recalls the last 100 commands. Ctrl+L clears output. Output is capped at 120 KB and 1,000 chunks. Keep secrets out of shared logs.</small>
        </div>
      </Show>
    </section>
  );
}
