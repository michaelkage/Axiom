import { createSignal, Show, For, onMount, onCleanup } from "solid-js";

interface BrowserSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  description: string;
  headings: Array<{ level: number; text: string }>;
  controls: Array<{ tag: string; type: string; label: string; placeholder: string; disabled: boolean }>;
  links: Array<{ text: string; href: string }>;
  text: string;
  errors: string[];
}
interface BrowserBridge {
  browser: {
    open(url: string): Promise<{ sessionId: string; url: string; title: string }>;
    navigate(sessionId: string, url: string): Promise<{ url: string; title: string }>;
    inspect(sessionId: string): Promise<BrowserSnapshot>;
    screenshot(sessionId: string): Promise<{ dataUrl: string }>;
    close(sessionId: string): Promise<void>;
    onClosed(callback: (sessionId: string) => void): () => void;
  };
}
function api(): BrowserBridge | undefined {
  return (window as unknown as { axiomDesktop?: BrowserBridge }).axiomDesktop;
}
function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Browser operation failed.";
}

export function BrowserInspectorPanel(props: {
  onAnalyze: (snapshot: BrowserSnapshot) => Promise<void>;
  canAnalyze?: boolean;
}) {
  const [url, setUrl] = createSignal("http://localhost:3000");
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal<BrowserSnapshot | null>(null);
  const [screenshot, setScreenshot] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [analysisBusy, setAnalysisBusy] = createSignal(false);

  const open = async () => {
    const bridge = api();
    if (!bridge || busy()) return;
    setBusy(true); setNotice(""); setSnapshot(null); setScreenshot("");
    try {
      const result = await bridge.browser.open(url().trim());
      setSessionId(result.sessionId);
      setUrl(result.url);
      setNotice("Browser session opened. Interact with the page in its browser window, then inspect it here.");
    } catch (error) { setNotice(normalizeError(error)); }
    finally { setBusy(false); }
  };
  const navigate = async () => {
    const bridge = api(), id = sessionId();
    if (!bridge || !id || busy()) return;
    setBusy(true); setNotice(""); setSnapshot(null); setScreenshot("");
    try {
      const result = await bridge.browser.navigate(id, url().trim());
      setUrl(result.url);
      setNotice("Navigation completed.");
    } catch (error) { setNotice(normalizeError(error)); }
    finally { setBusy(false); }
  };
  const inspect = async () => {
    const bridge = api(), id = sessionId();
    if (!bridge || !id || busy()) return;
    setBusy(true); setNotice("");
    try {
      const [page, image] = await Promise.all([
        bridge.browser.inspect(id),
        bridge.browser.screenshot(id),
      ]);
      setSnapshot(page);
      setScreenshot(image.dataUrl);
      setUrl(page.url);
      setNotice("Page snapshot and screenshot captured.");
    } catch (error) { setNotice(normalizeError(error)); }
    finally { setBusy(false); }
  };
  const close = async () => {
    const bridge = api(), id = sessionId();
    if (!bridge || !id || busy()) return;
    setBusy(true);
    try { await bridge.browser.close(id); setSessionId(null); setSnapshot(null); setScreenshot(""); setNotice("Browser session closed."); }
    catch (error) { setNotice(normalizeError(error)); }
    finally { setBusy(false); }
  };
  const analyze = async () => {
    const page = snapshot();
    if (!page || analysisBusy()) return;
    setAnalysisBusy(true);
    try { await props.onAnalyze(page); setNotice("Browser evidence sent to the current Axiom conversation."); }
    catch (error) { setNotice(normalizeError(error)); }
    finally { setAnalysisBusy(false); }
  };

  return <section class="axiom-browser" aria-label="Browser intelligence">
    <div class="axiom-browser__heading">
      <div><strong>Browser intelligence</strong><small>Open a running app, inspect its live DOM, console errors and visual state</small></div>
      <span>{sessionId() ? "SESSION ACTIVE" : "READY"}</span>
    </div>
    <div class="axiom-browser__url">
      <input aria-label="Application URL" value={url()} onInput={event => setUrl(event.currentTarget.value)} placeholder="https://your-preview.example" />
      <button type="button" disabled={!url().trim() || busy() || !api()} onClick={() => void (sessionId() ? navigate() : open())}>{busy() ? "Working…" : sessionId() ? "Navigate" : "Open browser"}</button>
    </div>
    <Show when={sessionId()}>
      <div class="axiom-browser__actions">
        <button type="button" disabled={busy()} onClick={() => void inspect()}>Inspect page</button>
        <button type="button" disabled={busy()} onClick={() => void close()}>Close session</button>
      </div>
    </Show>
    <Show when={notice()}><p class="axiom-browser__notice" role="status">{notice()}</p></Show>
    <Show when={snapshot()}>
      <div class="axiom-browser__summary">
        <strong>{snapshot()!.title || "Untitled page"}</strong>
        <small>{snapshot()!.url} · {snapshot()!.viewport.width}×{snapshot()!.viewport.height} · {new Date(snapshot()!.capturedAt).toLocaleTimeString()}</small>
        <p>{snapshot()!.description || "No meta description."}</p>
        <div class="axiom-browser__metrics">
          <span>{snapshot()!.headings.length} headings</span>
          <span>{snapshot()!.controls.length} controls</span>
          <span>{snapshot()!.links.length} links</span>
          <span classList={{ "has-errors": snapshot()!.errors.length > 0 }}>{snapshot()!.errors.length} browser errors</span>
        </div>
      </div>
      <Show when={screenshot()}>
        <img class="axiom-browser__screenshot" src={screenshot()} alt="Captured application screenshot" />
      </Show>
      <Show when={snapshot()!.errors.length > 0}>
        <div class="axiom-browser__errors"><strong>Console and page errors</strong><For each={snapshot()!.errors}>{error => <p>{error}</p>}</For></div>
      </Show>
      <details>
        <summary>DOM and accessibility-oriented snapshot</summary>
        <pre>{snapshot()!.text}</pre>
      </details>
      <button class="axiom-browser__analyze" type="button" disabled={!props.canAnalyze || analysisBusy()} onClick={() => void analyze()}>{analysisBusy() ? "Sending…" : "Analyze in current conversation"}</button>
    </Show>
    <small class="axiom-browser__footnote">Browser sessions use an isolated, temporary profile. Permissions and downloads are blocked by default. Only HTTP and HTTPS pages are allowed.</small>
  </section>;
}
