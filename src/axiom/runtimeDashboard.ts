import * as vscode from "vscode";
import { getAxiomConfig } from "./axiomConfig";
import { OmniRouteClient } from "./omniRouteClient";
import { AxiomRuntimeService, type RuntimeEvent } from "./runtimeService";

export function openAxiomRuntimeDashboard(context: vscode.ExtensionContext, runtime: AxiomRuntimeService): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "axiom.runtimeDashboard",
    "Axiom Runtime",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const nonce = [...Array(32)].map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 62))).join("");
  panel.webview.html = getDashboardHtml(panel.webview, nonce);
  const postEvent = (event: RuntimeEvent) => { void panel.webview.postMessage({ type: "runtimeEvent", event }); };
  const subscription = runtime.subscribe(postEvent);
  panel.onDidDispose(() => subscription.dispose(), undefined, context.subscriptions);

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;
    if (type === "refresh") {
      const config = getAxiomConfig();
      const [gateway, openCode] = await Promise.all([
        new OmniRouteClient().healthCheck(),
        Promise.resolve({ ready: runtime ? true : false }),
      ]);
      await panel.webview.postMessage({
        type: "status", gatewayUrl: config.gatewayUrl, plannerModel: config.plannerModel,
        workerModel: config.workerModel, maxConcurrentWorkers: config.enableSubAgents ? config.maxConcurrentWorkers : 1,
        enabled: config.enableSubAgents, healing: config.errorHealingLevel, ...gateway,
        openCodeReady: openCode.ready,
      });
      for (const event of runtime.getEvents()) postEvent(event);
    } else if (type === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "axiom");
    } else if (type === "runGoal") {
      const goal = await vscode.window.showInputBox({
        title: "Axiom — plan and execute with OpenCode workers",
        prompt: "Describe the outcome. Axiom will plan tasks, then execute each in its own OpenCode session.",
        placeHolder: "e.g. Add retry handling to the API client and tests",
        ignoreFocusOut: true,
      });
      if (!goal?.trim()) return;
      try {
        await runtime.runGoal(goal.trim());
      } catch (error) {
        void vscode.window.showErrorMessage(`Axiom run failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (type === "cancelRun") {
      runtime.cancelRun();
    }
  }, undefined, context.subscriptions);
  return panel;
}

function getDashboardHtml(webview: vscode.Webview, nonce: string): string {
  const csp = webview.cspSource;
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Axiom Runtime</title>
<style>
:root{color-scheme:light dark}body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:1100px;margin:auto}
h1{font-size:24px;font-weight:600;margin-bottom:4px}.muted{color:var(--vscode-descriptionForeground)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;background:var(--vscode-sideBar-background)}.label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--vscode-descriptionForeground)}.value{font-size:16px;font-weight:600;margin-top:8px;overflow-wrap:anywhere}.status{display:inline-block;border-radius:20px;padding:4px 9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}button{border:0;border-radius:4px;padding:8px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;margin:8px 8px 0 0}button:hover{background:var(--vscode-button-hoverBackground)}#details{white-space:pre-wrap;overflow-wrap:anywhere}.ok{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-errorForeground)}.section{margin-top:24px}.event{border-bottom:1px solid var(--vscode-panel-border);padding:9px 2px;overflow-wrap:anywhere}.event strong{margin-right:8px}.event small{color:var(--vscode-descriptionForeground)}#events{max-height:380px;overflow:auto}#diagnostics{max-height:220px;overflow:auto}
</style></head><body>
<h1>Axiom Runtime</h1><div class="muted">Planner → isolated OpenCode worker sessions → live diagnostics</div>
<div class="grid">
<section class="card"><div class="label">OmniRoute gateway</div><div class="value" id="gateway">Checking…</div><p id="connection" class="status">Not checked</p></section>
<section class="card"><div class="label">OpenCode sessions</div><div class="value" id="opencode">Checking…</div></section>
<section class="card"><div class="label">Planner model</div><div class="value" id="planner">—</div></section>
<section class="card"><div class="label">Worker model alias</div><div class="value" id="worker">—</div></section>
<section class="card"><div class="label">Worker concurrency</div><div class="value" id="workers">—</div></section>
<section class="card"><div class="label">Error healing</div><div class="value" id="healing">—</div></section>
<section class="card"><div class="label">Gateway latency</div><div class="value" id="latency">—</div></section>
<section class="card"><div class="label">Diagnostic events</div><div class="value" id="diagnosticCount">0</div></section>
</div>
<div><button id="run">Plan &amp; run goal</button><button id="cancel">Cancel run</button><button id="refresh">Refresh status</button><button id="settings">Open Axiom settings</button></div>
<p id="details" class="muted">Worker execution uses OpenCode sessions; planner JSON is supplied by OmniRoute. Diagnostic events are streamed from VS Code's language diagnostics API.</p>
<section class="section"><h2>Workers &amp; runtime events</h2><div id="events" class="card"><span class="muted">Waiting for runtime events…</span></div></section>
<section class="section"><h2>Recent diagnostics</h2><div id="diagnostics" class="card"><span class="muted">Waiting for diagnostics…</span></div></section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi(); const events=[]; const diagnostics=[]; let diagnosticCount=0;
const esc = value => String(value??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
document.getElementById('settings').addEventListener('click',()=>vscode.postMessage({type:'openSettings'}));
document.getElementById('run').addEventListener('click',()=>vscode.postMessage({type:'runGoal'}));
document.getElementById('cancel').addEventListener('click',()=>vscode.postMessage({type:'cancelRun'}));
function renderEvents(){const root=document.getElementById('events');root.innerHTML=events.length?events.slice(-100).reverse().map(e=>'<div class="event"><strong>'+esc(e.kind==='worker'?'Worker '+e.taskId:e.kind==='diagnostic'?'Diagnostic': 'Run')+'</strong><span class="status">'+esc(e.state||e.severity||'event')+'</span><div>'+esc(e.scope||e.file||e.goal||'')+'</div>'+(e.detail||e.message?'<div>'+esc(e.detail||e.message)+'</div>':'')+'<small>'+new Date(e.at).toLocaleTimeString()+(e.sessionId?' · session '+esc(e.sessionId):'')+'</small></div>').join(''):'<span class="muted">Waiting for runtime events…</span>';}
function renderDiagnostics(){document.getElementById('diagnostics').innerHTML=diagnostics.slice(-40).reverse().map(e=>'<div class="event"><strong>'+esc(e.severity)+'</strong>'+esc(e.file)+':'+esc(e.line)+'<div>'+esc(e.message)+'</div><small>'+new Date(e.at).toLocaleTimeString()+'</small></div>').join('')||'<span class="muted">No diagnostics observed yet.</span>';}
window.addEventListener('message',event=>{
 const data=event.data||{};
 if(data.type==='status'){
  document.getElementById('gateway').textContent=data.gatewayUrl||'—';document.getElementById('planner').textContent=data.plannerModel||'—';document.getElementById('worker').textContent=data.workerModel||'—';
  document.getElementById('workers').textContent=String(data.maxConcurrentWorkers??'—')+(data.enabled?' enabled':' (serial)');
  document.getElementById('healing').textContent=data.healing||'—';document.getElementById('latency').textContent=typeof data.latencyMs==='number'?data.latencyMs+' ms':'—';
  document.getElementById('opencode').textContent=data.openCodeReady?'Ready':'Unavailable';const s=document.getElementById('connection');s.textContent=data.ok?'Connected':'Unavailable';s.className='status '+(data.ok?'ok':'bad');
  document.getElementById('details').textContent=data.ok?'Gateway responded successfully. Worker tasks run through OpenCode sessions.':('Gateway unavailable: '+(data.error||'unknown error')+'. Check OmniRoute and axiom.gatewayUrl.');
 } else if(data.type==='runtimeEvent'&&data.event){
  const e=data.event;events.push(e);if(e.kind==='diagnostic'){diagnostics.push(e);diagnosticCount++;document.getElementById('diagnosticCount').textContent=String(diagnosticCount);renderDiagnostics();}renderEvents();
 }
});
window.addEventListener('load',()=>vscode.postMessage({type:'refresh'}));
</script></body></html>`;
}
