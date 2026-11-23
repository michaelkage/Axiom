"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("axiomDesktop", Object.freeze({
  postMessage(message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      throw new TypeError("Axiom messages must have a string type.");
    }
    ipcRenderer.send("axiom:webview-message", message);
  },
  security: Object.freeze({
    audit: () => ipcRenderer.invoke("axiom:security-audit-list"),
    verifyAudit: () => ipcRenderer.invoke("axiom:security-audit-verify"),
    readPolicy: () => ipcRenderer.invoke("axiom:security-policy-read"),
    updatePolicy: request => ipcRenderer.invoke("axiom:security-policy-update", request)
  }),
  plugins: Object.freeze({
    list: () => ipcRenderer.invoke("axiom:plugin-list"),
    run: request => ipcRenderer.invoke("axiom:plugin-run", request)
  }),
  mcp: Object.freeze({
    status: () => ipcRenderer.invoke("axiom:mcp-status"),
    diagnostics: () => ipcRenderer.invoke("axiom:mcp-diagnostics"),
    probeWorker: id => ipcRenderer.invoke("axiom:mcp-worker-probe", id),
    saveSecret: request => ipcRenderer.invoke("axiom:mcp-save-secret", request),
    setEnabled: request => ipcRenderer.invoke("axiom:mcp-enable", request),
    remove: id => ipcRenderer.invoke("axiom:mcp-remove", id)
  }),
  telemetry: Object.freeze({ snapshot: () => ipcRenderer.invoke("axiom:telemetry-snapshot") }),
  omniRoute: Object.freeze({
    status: () => ipcRenderer.invoke("axiom:omniroute-status"),
    check: settings => ipcRenderer.invoke("axiom:omniroute-check", settings),
    save: settings => ipcRenderer.invoke("axiom:omniroute-save", settings),
    install: () => ipcRenderer.invoke("axiom:omniroute-install"),
    start: () => ipcRenderer.invoke("axiom:omniroute-start"),
    stop: () => ipcRenderer.invoke("axiom:omniroute-stop"),
    openDashboard: () => ipcRenderer.invoke("axiom:omniroute-dashboard")
  }),
  terminal: Object.freeze({
    run: request => ipcRenderer.invoke("axiom:terminal-run", request),
    cancel: requestId => ipcRenderer.invoke("axiom:terminal-cancel", requestId),
    onOutput(callback) {
      const listener = (_event, chunk) => callback(chunk);
      ipcRenderer.on("axiom:terminal-output", listener);
      return () => ipcRenderer.removeListener("axiom:terminal-output", listener);
    }
  }),
  remoteWorkspace: Object.freeze({
    list: () => ipcRenderer.invoke("axiom:remote-workspace-list"),
    create: request => ipcRenderer.invoke("axiom:remote-workspace-create", request),
    retryClone: id => ipcRenderer.invoke("axiom:remote-workspace-retry-clone", id),
    commitAndPush: request => ipcRenderer.invoke("axiom:remote-workspace-commit-push", request),
    reconcile: id => ipcRenderer.invoke("axiom:remote-workspace-reconcile", id),
    pushRecovered: request => ipcRenderer.invoke("axiom:remote-workspace-push-recovered", request),
    cancel: id => ipcRenderer.invoke("axiom:remote-workspace-cancel", id),
    cleanup: id => ipcRenderer.invoke("axiom:remote-workspace-cleanup", id)
  }),
  remoteWorker: Object.freeze({
    config: () => ipcRenderer.invoke("axiom:remote-worker-config"),
    save: request => ipcRenderer.invoke("axiom:remote-worker-config-save", request),
    test: () => ipcRenderer.invoke("axiom:remote-worker-test"),
    list: () => ipcRenderer.invoke("axiom:remote-worker-list"),
    submit: request => ipcRenderer.invoke("axiom:remote-worker-submit", request),
    get: id => ipcRenderer.invoke("axiom:remote-worker-get", id),
    getPatch: id => ipcRenderer.invoke("axiom:remote-worker-patch", id),
    cancel: id => ipcRenderer.invoke("axiom:remote-worker-cancel", id),
    retry: request => ipcRenderer.invoke("axiom:remote-worker-retry", request),
    applyPatch: request => ipcRenderer.invoke("axiom:remote-worker-apply-patch", request)
  }),
  browser: Object.freeze({
    open: url => ipcRenderer.invoke("axiom:browser-open", url),
    navigate: (sessionId, url) => ipcRenderer.invoke("axiom:browser-navigate", { sessionId, url }),
    inspect: sessionId => ipcRenderer.invoke("axiom:browser-inspect", { sessionId }),
    act: (sessionId, action) => ipcRenderer.invoke("axiom:browser-act", { sessionId, action }),
    screenshot: sessionId => ipcRenderer.invoke("axiom:browser-screenshot", { sessionId }),
    close: sessionId => ipcRenderer.invoke("axiom:browser-close", { sessionId }),
    onClosed(callback) {
      const listener = (_event, sessionId) => callback(sessionId);
      ipcRenderer.on("axiom:browser-closed", listener);
      return () => ipcRenderer.removeListener("axiom:browser-closed", listener);
    }
  }),
  deployment: Object.freeze({
    preview: request => ipcRenderer.invoke("axiom:deployment-preview", request),
    history: () => ipcRenderer.invoke("axiom:deployment-history")
  }),
  providerCredentials: Object.freeze({
    status: () => ipcRenderer.invoke("axiom:provider-credential-status"),
    save: request => ipcRenderer.invoke("axiom:provider-credential-save", request),
    remove: providerId => ipcRenderer.invoke("axiom:provider-credential-remove", providerId)
  }),
  projectKnowledge: Object.freeze({
    scanWorkspace: () => ipcRenderer.invoke("axiom:knowledge-index-scan"),
    readIndex: () => ipcRenderer.invoke("axiom:knowledge-index-read"),
    updateIndex: request => ipcRenderer.invoke("axiom:knowledge-index-update", request),
    searchIndex: request => ipcRenderer.invoke("axiom:knowledge-index-search", request),
    readMemory: () => ipcRenderer.invoke("axiom:knowledge-memory-read"),
    upsertMemory: record => ipcRenderer.invoke("axiom:knowledge-memory-upsert", record),
    searchMemory: request => ipcRenderer.invoke("axiom:knowledge-memory-search", request),
    removeMemory: id => ipcRenderer.invoke("axiom:knowledge-memory-remove", id)
  }),
  artifacts: Object.freeze({
    list: taskId => ipcRenderer.invoke("axiom:artifact-list", taskId),
    put: request => ipcRenderer.invoke("axiom:artifact-put", request),
    read: artifactId => ipcRenderer.invoke("axiom:artifact-read", artifactId),
    remove: artifactId => ipcRenderer.invoke("axiom:artifact-remove", artifactId)
  }),
  executionLedger: Object.freeze({
    list: () => ipcRenderer.invoke("axiom:execution-ledger-list"),
    get: objectiveId => ipcRenderer.invoke("axiom:execution-ledger-get", objectiveId),
    create: objective => ipcRenderer.invoke("axiom:execution-ledger-create", objective),
    commit: request => ipcRenderer.invoke("axiom:execution-ledger-commit", request),
    remove: request => ipcRenderer.invoke("axiom:execution-ledger-remove", request)
  }),
  project: Object.freeze({
    bootstrap: () => ipcRenderer.invoke("axiom:project-bootstrap"),
    readState: () => ipcRenderer.invoke("axiom:project-state-read"),
    listWorkerTasks: () => ipcRenderer.invoke("axiom:worker-state-list"),
    recordWorkerTask: task => ipcRenderer.invoke("axiom:worker-state-record", task),
    saveContext: context => ipcRenderer.invoke("axiom:project-context-save", context),
    addChange: change => ipcRenderer.invoke("axiom:change-feed-add", change),
    chooseProject: () => ipcRenderer.invoke("axiom:choose-project"),
    createProject: () => ipcRenderer.invoke("axiom:create-project"),
    listFiles: relativePath => ipcRenderer.invoke("axiom:fs-list", relativePath),
    readFile: relativePath => ipcRenderer.invoke("axiom:fs-read", relativePath),
    writeFile: (relativePath, content) => ipcRenderer.invoke("axiom:fs-write", relativePath, content)
  })
}));

ipcRenderer.on("axiom:host-message", (_event, message) => {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
  if (message && message.type === "project-state-updated") {
    window.dispatchEvent(new Event("axiom-project-state-updated"));
  }
  if (message && message.type === "worker-state-updated") {
    window.dispatchEvent(new Event("axiom-worker-state-updated"));
  }
});
