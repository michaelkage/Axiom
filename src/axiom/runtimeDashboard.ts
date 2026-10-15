import * as vscode from "vscode";
import { getAxiomConfig } from "./axiomConfig";
import { OmniRouteClient } from "./omniRouteClient";

export function openAxiomRuntimeDashboard(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "axiom.runtimeDashboard",
    "Axiom Runtime",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const nonce = [...Array(32)].map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 62))).join("");
  panel.webview.html = getDashboardHtml(panel.webview, nonce);
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;
    if (type === "refresh") {
      const config = getAxiomConfig();
      const result = await new OmniRouteClient().healthCheck();
      await panel.webview.postMessage({
        type: "status",
        gatewayUrl: config.gatewayUrl,
        plannerModel: config.plannerModel,
        workerModel: config.workerModel,
        maxConcurrentWorkers: config.enableSubAgents ? config.maxConcurrentWorkers : 1,
        enabled: config.enableSubAgents,
        healing: config.errorHealingLevel,
        ...result,
      });
    } else if (type === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "axiom");
    }
  }, undefined, context.subscriptions);
  void panel.webview.postMessage({ type: "ready" });
  return panel;
}

function getDashboardHtml(webview: vscode.Webview, nonce: string): string {
  const csp = webview.cspSource;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Axiom Runtime</title>
<style>
:root{color-scheme:light dark}body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:900px;margin:auto}
h1{font-size:24px;font-weight:600;margin-bottom:4px}.muted{color:var(--vscode-descriptionForeground)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:20px 0}.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:16px;background:var(--vscode-sideBar-background)}.label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--vscode-descriptionForeground)}.value{font-size:16px;font-weight:600;margin-top:8px;overflow-wrap:anywhere}.status{display:inline-block;border-radius:20px;padding:4px 9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}button{border:0;border-radius:4px;padding:8px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;margin:8px 8px 0 0}button:hover{background:var(--vscode-button-hoverBackground)}#details{white-space:pre-wrap;overflow-wrap:anywhere}.ok{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-errorForeground)}
</style>
</head>
<body>
<h1>Axiom Runtime</h1>
<div class="muted">Local model routing and orchestration status</div>
<div class="grid">
<section class="card"><div class="label">OmniRoute gateway</div><div class="value" id="gateway">Checking…</div><p id="connection" class="status">Not checked</p></section>
<section class="card"><div class="label">Planner model</div><div class="value" id="planner">—</div></section>
<section class="card"><div class="label">Worker model</div><div class="value" id="worker">—</div></section>
<section class="card"><div class="label">Parallel workers</div><div class="value" id="workers">—</div></section>
<section class="card"><div class="label">Error healing</div><div class="value" id="healing">—</div></section>
<section class="card"><div class="label">Latency</div><div class="value" id="latency">—</div></section>
</div>
<div><button id="refresh">Check gateway</button><button id="settings">Open Axiom settings</button></div>
<p id="details" class="muted">A successful probe checks the gateway's /models endpoint. It does not prove that every configured model alias is available.</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('refresh').addEventListener('click', () => { document.getElementById('connection').textContent='Checking…'; vscode.postMessage({type:'refresh'}); });
document.getElementById('settings').addEventListener('click', () => vscode.postMessage({type:'openSettings'}));
window.addEventListener('message', event => {
 const data=event.data||{};
 if(data.type!=='status') return;
 document.getElementById('gateway').textContent=data.gatewayUrl||'—';
 document.getElementById('planner').textContent=data.plannerModel||'—';
 document.getElementById('worker').textContent=data.workerModel||'—';
 document.getElementById('workers').textContent=String(data.maxConcurrentWorkers??'—')+(data.enabled?' active':' (parallelism disabled)');
 document.getElementById('healing').textContent=data.healing||'—';
 document.getElementById('latency').textContent=typeof data.latencyMs==='number'?data.latencyMs+' ms':'—';
 const status=document.getElementById('connection');
 status.textContent=data.ok?'Connected':'Unavailable';
 status.className='status '+(data.ok?'ok':'bad');
 document.getElementById('details').textContent=data.ok?'Gateway responded successfully. '+(data.error||''):('Could not reach gateway: '+(data.error||'unknown error')+'. Check that OmniRoute is running and axiom.gatewayUrl is correct.');
});
window.addEventListener('load',()=>vscode.postMessage({type:'refresh'}));
</script>
</body></html>`;
}
