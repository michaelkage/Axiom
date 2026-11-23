import { createEffect, createSignal, For, Show } from "solid-js";

type Decision = "allow" | "approval-required" | "deny";
type WorkspacePolicy = {
  "filesystem.read": "allow" | "deny";
  "filesystem.write": "approval-required" | "deny";
  "shell.execute": "approval-required" | "deny";
  "network.request": Decision;
  "network.allowedHosts": string[];
  "mcp.invoke": "approval-required" | "deny";
  "git.push": "approval-required" | "deny";
  "deployment.publish": "approval-required" | "deny";
  "plugin.execute": "approval-required" | "deny";
};
type PolicyRecord = { revision: number; policy: WorkspacePolicy; updatedAt: string | null };
type AuditEvent = { sequence: number; timestamp: string; action: string; decision: string; reason: string; resource: string | null; hash: string; legacyUnverified?: boolean };
type SecurityApi = {
  readPolicy: () => Promise<PolicyRecord>;
  updatePolicy: (request: { policy: WorkspacePolicy; expectedRevision: number }) => Promise<PolicyRecord>;
  audit: () => Promise<AuditEvent[]>;
  verifyAudit: () => Promise<{ verified: boolean; sequence: number }>;
};
function securityApi(): SecurityApi | undefined {
  return (window as Window & { axiomDesktop?: { security?: SecurityApi } }).axiomDesktop?.security;
}

const FIELDS: Array<{ key: keyof Omit<WorkspacePolicy, "network.allowedHosts">; label: string; options: Decision[] }> = [
  { key: "filesystem.read", label: "Project file reads", options: ["allow", "deny"] },
  { key: "filesystem.write", label: "Project file writes", options: ["approval-required", "deny"] },
  { key: "shell.execute", label: "Shell and worker commands", options: ["approval-required", "deny"] },
  { key: "network.request", label: "Outbound network requests", options: ["deny", "approval-required", "allow"] },
  { key: "mcp.invoke", label: "MCP tools and resources", options: ["approval-required", "deny"] },
  { key: "git.push", label: "Git pushes", options: ["approval-required", "deny"] },
  { key: "deployment.publish", label: "Deployment publishing", options: ["approval-required", "deny"] },
  { key: "plugin.execute", label: "Plugin execution", options: ["approval-required", "deny"] }
];

export function SecurityPolicyPanel(props: { workspaceRoot?: string }) {
  const [policy, setPolicy] = createSignal<WorkspacePolicy | null>(null);
  const [revision, setRevision] = createSignal(0);
  const [hostsText, setHostsText] = createSignal("");
  const [events, setEvents] = createSignal<AuditEvent[]>([]);
  const [auditStatus, setAuditStatus] = createSignal("Not verified");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  async function refresh() {
    const api = securityApi();
    if (!api || !props.workspaceRoot) { setPolicy(null); setEvents([]); setAuditStatus("Desktop project required"); return; }
    setLoading(true);
    try {
      const [record, rows, verification] = await Promise.all([api.readPolicy(), api.audit(), api.verifyAudit()]);
      setPolicy(record.policy);
      setRevision(record.revision);
      setHostsText(record.policy["network.allowedHosts"].join("\n"));
      setEvents(rows.slice(-20).reverse());
      setAuditStatus(verification.verified ? "Verified · " + verification.sequence + " events" : "Integrity verification failed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load workspace security state.");
      setAuditStatus("Verification unavailable");
    } finally { setLoading(false); }
  }
  createEffect(() => { props.workspaceRoot; void refresh(); });

  function setDecision(key: keyof Omit<WorkspacePolicy, "network.allowedHosts">, value: string) {
    setPolicy(current => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    const api = securityApi();
    const current = policy();
    if (!api || !current || busy()) return;
    setBusy(true); setMessage("");
    try {
      const allowedHosts = hostsText().split(/[\n,]+/).map(host => host.trim()).filter(Boolean);
      const updated = await api.updatePolicy({
        expectedRevision: revision(),
        policy: { ...current, "network.allowedHosts": allowedHosts }
      });
      setPolicy(updated.policy);
      setRevision(updated.revision);
      setHostsText(updated.policy["network.allowedHosts"].join("\n"));
      setMessage("Workspace security policy saved at revision " + updated.revision + ".");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Security policy update failed.");
      if (String(error).includes("revision")) await refresh();
    } finally { setBusy(false); }
  }

  return <section class="workflow-plan workflow-plan--plugins" aria-label="Workspace security policy">
    <div class="workflow-plan__eyebrow">SECURITY CONTROL CENTRE <span>WORKSPACE POLICY</span></div>
    <h2>Security and permissions</h2>
    <p class="workflow-plan__prompt">These controls are enforced by Axiom's desktop main process and injected into the OpenCode runtime permission configuration. Privileged policy changes always require native confirmation. Denials take precedence over approvals.</p>
    <Show when={loading()}><p role="status">Loading policy and verifying audit chain…</p></Show>
    <Show when={policy()} keyed>
      {(current) => <>
        <p>Policy revision {revision()}{ " · " }Workspace: {props.workspaceRoot}</p>
        <div class="workflow-plan__actions">
          <For each={FIELDS}>{field => <label class="omniroute-setup__field">{field.label}
            <select value={current[field.key]} onChange={event => setDecision(field.key, event.currentTarget.value)}>
              <For each={field.options}>{option => <option value={option}>{option === "approval-required" ? "Ask for approval" : option === "allow" ? "Allow" : "Deny"}</option>}</For>
            </select>
          </label>}</For>
        </div>
        <label class="omniroute-setup__field">Additional outbound HTTPS host allowlist
          <textarea rows={4} value={hostsText()} onInput={event => setHostsText(event.currentTarget.value)} placeholder={"docs.example.com\napi.example.com"} />
        </label>
        <small>Enter exact hostnames, one per line. Wildcards, IP literals, localhost and plain HTTP allowlist entries are rejected. The explicitly approved browser origin remains available to that browser session.</small>
        <div class="workflow-plan__actions">
          <button type="button" class="workflow-plan__primary" disabled={busy() || !props.workspaceRoot} onClick={() => void save()}>{busy() ? "Saving…" : "Save policy (native approval required)"}</button>
          <button type="button" class="workflow-plan__secondary" disabled={busy() || loading()} onClick={() => void refresh()}>Refresh policy and audit</button>
        </div>
      </>}
    </Show>
    <div class="workflow-plan__parallel" aria-label="Security audit integrity">
      <div class="workflow-plan__eyebrow">TAMPER-EVIDENT AUDIT <span>{auditStatus()}</span></div>
      <p>Audit events are HMAC chained and the latest sequence/hash is anchored in OS-encrypted credential storage. Altered events, missing tails, missing logs or anchor mismatches block privileged operations.</p>
      <Show when={events().some(event => event.legacyUnverified)}><p role="status">Some historical events were migrated from the previous unchained log and cannot be authenticated retroactively.</p></Show>
      <For each={events()}>{event => <article class="workflow-plan__parallel">
        <strong>#{event.sequence} · {event.action} · {event.decision}</strong>
        <small>{new Date(event.timestamp).toLocaleString()} · {event.resource || "No resource"} · {event.hash.slice(0, 16)}…</small>
        <p>{event.reason}</p>
      </article>}</For>
    </div>
    <Show when={message()}><p role="status" class="omniroute-setup__message">{message()}</p></Show>
  </section>;
}
