const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createProjectStore } = require("./project-store.cjs");
const { createSecureStorage } = require("./secure-storage.cjs");
const { createDeploymentManager } = require("./deployment-provider.cjs");
const { createDeploymentHistoryStore } = require("./deployment-history.cjs");
const { validateRemoteWorkerConfig, createRemoteWorkerHostClient } = require("./remote-worker-host-client.cjs");
const { applyRemoteWorkerPatch } = require("./remote-patch-importer.cjs");
const { validateBrowserNavigation } = require("./browser-url.cjs");
const { normalizeBrowserAction, buildBrowserActionScript } = require("./browser-actions.cjs");
const { redactSecrets } = require("./security-redaction.cjs");
const { listDirectory, readProjectFile, writeProjectFile } = require("./filesystem.cjs");
const { createTerminalRunner } = require("./terminal.cjs");
const { createOmniRouteManager } = require("./omniroute.cjs");
const { classifyWorkspaceDrift } = require("./workspace-drift.cjs");
const { normalizeWorkspaceRelativePath, resolveSafeWorkspaceFile, parseGitStatusPorcelainZ, resolveWorkerQualityStatus, readRegularFileNoFollow, applyStagedWorkspaceFiles, withWorkspaceIntegrationLock } = require("./worktree-integration.cjs");
const { createWorkerStateStore } = require("./worker-state.cjs");
const { createExecutionLedger } = require("./execution-ledger.cjs");
const { createProviderCredentialManager } = require("./provider-credentials.cjs");
const { createExecutionArtifactStore } = require("./execution-artifacts.cjs");
const { createExecutionTelemetry } = require("./execution-telemetry.cjs");
const { createOpenCodeTelemetryBridge } = require("./opencode-telemetry-bridge.cjs");
const { createWorkerOwnershipRegistry } = require("./worker-ownership.cjs");
const { createProjectKnowledgeStore } = require("./project-knowledge-store.cjs");
const { createDetachedWorktree } = require("./worker-worktree.cjs");
const { createMcpManager } = require("./mcp-manager.cjs");
const { createPluginHost, PLUGIN_DIRECTORY } = require("./plugin-host.cjs");
const { evaluateFilesystemAccess, combineFilesystemDecisions, createSecurityAuditStore } = require("./security-enforcement.cjs");
const { createWorkspaceSecurityPolicyStore } = require("./workspace-security-policy.cjs");
const { applyRuntimePermissionPolicy } = require("./runtime-policy.cjs");
const { createNetworkPolicyProxy } = require("./network-policy-proxy.cjs");
const { createPlatformPluginSandbox } = require("./plugin-sandbox-linux.cjs");
const { inspectMcpRuntime, runWorkerToolProbe } = require("./mcp-runtime.cjs");
const { createRuntimeEnvironment } = require("./runtime-environment.cjs");
const { createRemoteWorkspace, commitAndPushWorkspace, reconcileRemoteWorkspace, pushReconciledWorkspace, cleanupRemoteWorkspace, discardInterruptedCloneWorkspace, git: remoteGit } = require("./remote-workspace-runner.cjs");
const { validateRemoteWorkspaceRequest, restoreRemoteWorkspaceJob, recoverInterruptedRemoteWorkspaceOperation } = require("./remote-workspace.cjs");
const execFileAsync = promisify(execFile);
let selectedWorkspace;
let runtimeProcess;
let terminalRunner;
let omniRouteManager;
let mcpManager;
let securityAuditStore;
let workspaceSecurityPolicyStore;
let runtimeNetworkProxy;
const runtimeNetworkApprovalCache = new Map();
function currentWorkspaceSecurityPolicyStore() {
  if (!workspaceSecurityPolicyStore) workspaceSecurityPolicyStore = createWorkspaceSecurityPolicyStore({ userDataPath: app.getPath("userData") });
  return workspaceSecurityPolicyStore;
}
function currentSecurityAuditStore() {
  if (!securityAuditStore) {
    const secureStore = currentSecureCredentialStore();
    let integrityKey = secureStore.get("security", "audit-integrity-key");
    if (!integrityKey) {
      integrityKey = require("node:crypto").randomBytes(32).toString("hex");
      secureStore.set("security", "audit-integrity-key", integrityKey);
    }
    if (!/^[a-f0-9]{64}$/i.test(integrityKey)) throw new Error("The protected security audit integrity key is invalid.");
    const readAnchor = () => {
      const value = secureStore.get("security", "audit-integrity-head");
      if (!value) return null;
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error("The protected security audit head is corrupt."); }
      return parsed;
    };
    securityAuditStore = createSecurityAuditStore({
      userDataPath: app.getPath("userData"),
      integrityKey,
      getAnchor: readAnchor,
      setAnchor: anchor => secureStore.set("security", "audit-integrity-head", JSON.stringify(anchor))
    });
  }
  return securityAuditStore;
}
async function authorizeFilesystemOperation(operation, relativePath) {
  const baseEvaluation = evaluateFilesystemAccess({ workspaceRoot: selectedWorkspace, relativePath, operation });
  const projectPolicy = selectedWorkspace ? currentWorkspaceSecurityPolicyStore().evaluate(selectedWorkspace, "filesystem." + operation) : { decision: "deny", reason: "No trusted workspace is selected." };
  const evaluation = combineFilesystemDecisions(baseEvaluation, projectPolicy);
  const projectId = selectedWorkspace ? require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40) : null;
  const audit = currentSecurityAuditStore();
  if (evaluation.decision === "deny") {
    audit.record({ action: "filesystem." + operation, decision: "deny", reason: evaluation.reason, projectId, resource: redactSecrets(String(relativePath || "")).slice(0, 512) });
    await appendRuntimeLog("Security policy denied filesystem." + operation + ": " + evaluation.reason);
    throw new Error("Security policy denied filesystem access: " + evaluation.reason);
  }
  if (evaluation.decision === "approval-required") {
    audit.record({ action: "filesystem." + operation, decision: "approval-required", reason: evaluation.reason, projectId, resource: redactSecrets(String(relativePath || "")).slice(0, 512) });
    try {
      await requirePrivilegedApproval({
        title: "Approve project file modification",
        message: "Allow Axiom to modify a file in the selected project?",
        detail: "Path: " + String(relativePath || "(project root)") + "\nPolicy: " + evaluation.reason,
        approveLabel: "Modify file"
      });
      audit.record({ action: "filesystem." + operation, decision: "allow", reason: "User approved the native filesystem confirmation.", projectId, resource: redactSecrets(String(relativePath || "")).slice(0, 512) });
    } catch (error) {
      audit.record({ action: "filesystem." + operation, decision: "deny", reason: "User denied or dismissed native filesystem confirmation.", projectId, resource: redactSecrets(String(relativePath || "")).slice(0, 512) });
      throw error;
    }
  } else {
    audit.record({ action: "filesystem." + operation, decision: "allow", reason: evaluation.reason, projectId, resource: redactSecrets(String(relativePath || "")).slice(0, 512) });
  }
  return true;
}
let pluginHost;
function currentPluginHost() {
  if (!pluginHost) {
    const root = path.join(app.getPath("userData"), PLUGIN_DIRECTORY);
    pluginHost = createPluginHost({
      root,
      spawnSandbox: request => createPlatformPluginSandbox().run(request),
      authorize: async ({ pluginId, capabilities }) => enforceWorkspacePolicyApproval("plugin.execute", {
        title: "Approve plugin execution",
        message: "Allow this installed plugin to execute in Axiom's isolated runtime?",
        detail: "Plugin: " + pluginId + "\\nRequested capabilities: " + (capabilities.length ? capabilities.join(", ") : "none"),
        approveLabel: "Run plugin",
        resource: "plugin:" + pluginId
      })
    });
  }
  return pluginHost;
}
const executionTelemetry = createExecutionTelemetry();
let openCodeTelemetryBridge;
let secureCredentialStore;
function currentSecureCredentialStore() {
  if (!secureCredentialStore) secureCredentialStore = createSecureStorage({ userDataPath: app.getPath("userData"), safeStorage });
  return secureCredentialStore;
}

function readRemoteWorkerSettings() {
  const store = currentSecureCredentialStore();
  return {
    hostUrl: store.get("worker-host", "host-url"),
    repositoryUrl: store.get("worker-host", "repository-url"),
    branch: store.get("worker-host", "branch"),
    enabled: store.get("worker-host", "enabled") === "true",
    tokenConfigured: Boolean(store.get("worker-host", "token")),
  };
}
function createRemoteWorkerHostClientForApp() {
  return createRemoteWorkerHostClient({
    getConfig: async () => ({ hostUrl: currentSecureCredentialStore().get("worker-host", "host-url") }),
    getToken: async () => currentSecureCredentialStore().get("worker-host", "token"),
  });
}

let activeRuntimeUrl = null;
let mainWindow;
let isQuitting = false;
let shutdownStarted = false;
const remoteWorkspaceJobs = new Map();
let workerOwnership;
let workerOwnershipWorkspace = null;
function ownershipForWorkspace(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  if (!workerOwnership || workerOwnershipWorkspace !== root) {
    const id = require("node:crypto").createHash("sha256").update(root).digest("hex").slice(0, 40);
    workerOwnership = createWorkerOwnershipRegistry({ filePath: path.join(app.getPath("userData"), "worker-ownership", id + ".json"), workspaceRoot: root });
    workerOwnershipWorkspace = root;
  }
  return workerOwnership;
}
const browserSessions = new Map();
const remoteWorkspaceOperations = new Map();
const remoteWorkspaceInstanceId = require("node:crypto").randomUUID();
async function runRemoteWorkspaceOperation(job, kind, operation) {
  if (remoteWorkspaceOperations.has(job.id)) throw new Error("This remote workspace already has an operation in progress.");
  const controller = new AbortController();
  remoteWorkspaceOperations.set(job.id, controller);
  job.operation = { kind, instanceId: remoteWorkspaceInstanceId, startedAt: Date.now() };
  job.lastActivityAt = Date.now();
  try {
    await persistRemoteWorkspaceJobs();
    return await operation(controller.signal);
  } catch (error) {
    if (error && error.name === "AbortError") {
      job.interruptedOperation = { kind, startedAt: job.operation.startedAt };
    }
    throw error;
  } finally {
    remoteWorkspaceOperations.delete(job.id);
    job.operation = null;
    job.lastActivityAt = Date.now();
    await persistRemoteWorkspaceJobs();
  }
}
function cancelRemoteWorkspaceOperation(id) {
  const controller = remoteWorkspaceOperations.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}
const remoteWorkspaceJobsFile = () => path.join(app.getPath("userData"), "remote-workspace-jobs.json");
let remoteWorkspacePersistQueue = Promise.resolve();
function persistRemoteWorkspaceJobs() {
  const writeSnapshot = async () => {
    const file = remoteWorkspaceJobsFile();
    const payload = [...remoteWorkspaceJobs.values()].map(job => ({
      id: job.id, mode: job.mode, repositoryUrl: job.repositoryUrl, branch: job.branch,
      paths: job.paths, workspacePath: job.workspacePath, temporaryRoot: job.temporaryRoot,
      workspaceOwnership: job.workspaceOwnership, status: job.status,
      remoteCommitConfirmed: job.remoteCommitConfirmed === true,
      verificationPassed: job.verificationPassed === true, pushSucceeded: job.pushSucceeded === true,
      commitSha: job.commitSha || null, error: job.error || null, operation: job.operation || null,
      interruptedOperation: job.interruptedOperation || null, lastActivityAt: job.lastActivityAt || null
    }));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + remoteWorkspaceInstanceId + ".tmp";
    await fs.promises.writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  };
  remoteWorkspacePersistQueue = remoteWorkspacePersistQueue.then(writeSnapshot, writeSnapshot);
  return remoteWorkspacePersistQueue;
}
async function restoreRemoteWorkspaceJobs() {
  try {
    const raw = await fs.promises.readFile(remoteWorkspaceJobsFile(), "utf8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs)) throw new Error("Invalid remote workspace job state.");
    const managedRoot = path.resolve(path.join(app.getPath("userData"), "remote-workspaces"));
    for (const persistedJob of jobs) {
      const job = restoreRemoteWorkspaceJob(persistedJob, managedRoot);
      if (!job) {
        await appendRuntimeLog("Skipped invalid or unsafe persisted remote workspace job.");
        continue;
      }
      const recovered = recoverInterruptedRemoteWorkspaceOperation({ ...job, operation: persistedJob.operation || null });
      Object.assign(job, recovered);
      if (job.interruptedOperation?.kind === "clone" && job.mode !== "persistent") {
        try {
          const cleanup = await discardInterruptedCloneWorkspace(job);
          await appendRuntimeLog("Recovered interrupted temporary clone " + job.id + ": " + (cleanup.removed ? "partial checkout removed." : "partial checkout already absent."));
        } catch (error) {
          job.error = "Interrupted clone could not be safely removed: " + String(error.message || error).slice(0, 300);
          await appendRuntimeLog("Could not clean interrupted clone " + job.id + ": " + job.error);
        }
      } else if (job.interruptedOperation?.kind === "clone" && job.mode === "persistent") {
        job.error = "Persistent clone was interrupted. Its destination was preserved; inspect it before retrying.";
      }
      job.lastActivityAt = Number(persistedJob.lastActivityAt) || null;
      remoteWorkspaceJobs.set(job.id, job);
    }
    await persistRemoteWorkspaceJobs();
  } catch (error) {
    if (error && error.code !== "ENOENT") await appendRuntimeLog("Could not restore remote workspace jobs: " + String(error.message || error).slice(0, 500));
  }
}
let stoppingRuntime = false;

app.setName("Axiom");
if (process.platform === "win32") app.setAppUserModelId("com.axiom.desktop");

function workspaceArgument() {
  const prefix = "--axiom-workspace=";
  const value = process.argv.find(arg => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

async function appendRuntimeLog(text) {
  try {
    const logPath = path.join(app.getPath("userData"), "logs", "runtime.log");
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await fs.promises.appendFile(logPath, `[${new Date().toISOString()}] ${redactSecrets(text)}\n`, "utf8");
  } catch { /* Diagnostics must never prevent startup or shutdown. */ }
}

async function runtimeExecutable() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules")
    : path.join(__dirname, "node_modules");
  const candidates = process.platform === "win32"
    ? [
        // Prefer native executables: launching a .cmd shim through a shell breaks
        // when the installation path contains spaces (for example, Program Files).
        path.join(base, "opencode-ai", "bin", "opencode.exe"),
        path.join(base, "opencode-windows-x64", "bin", "opencode.exe"),
        path.join(base, "opencode-windows-x64-baseline", "bin", "opencode.exe"),
        path.join(base, ".bin", "opencode.exe"),
        path.join(base, ".bin", "opencode.cmd"),
      ]
    : [
        path.join(base, "opencode-" + process.platform + "-" + process.arch, "bin", "opencode"),
        path.join(base, ".bin", "opencode"),
        path.join(base, "opencode-ai", "bin", "opencode"),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const globalLookup = await execFileAsync(
      process.platform === "win32" ? "where" : "which",
      ["opencode"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    if (globalLookup.stdout.trim()) return globalLookup.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  } catch { /* Fall through to the actionable runtime-not-found error. */ }
  throw new Error("Axiom's bundled runtime could not be found. Reinstall Axiom using the latest installer for your platform.");
}

async function runtimeConfigurationEnvironment(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("A trusted runtime workspace is required.");
  const merged = {};
  for (const manager of [omniRouteManager, mcpManager]) {
    const environment = manager ? manager.openCodeEnvironment({ workspaceRoot }) : {};
    if (environment.OPENCODE_CONFIG_CONTENT) {
      try { Object.assign(merged, JSON.parse(environment.OPENCODE_CONFIG_CONTENT)); }
      catch { throw new Error("Axiom generated invalid local runtime configuration; startup was blocked."); }
    }
  }
  const policy = currentWorkspaceSecurityPolicyStore().read(workspaceRoot).policy;
  const configuredProvider = merged.provider && merged.provider.omniroute;
  const routerBaseUrl = configuredProvider?.options?.baseURL;
  if (typeof routerBaseUrl === "string") {
    let routerUrl;
    try { routerUrl = new URL(routerBaseUrl); } catch { throw new Error("OmniRoute provider endpoint is invalid; runtime startup was blocked."); }
    const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(routerUrl.hostname.toLowerCase());
    if (!isLoopback) await authorizeRuntimeNetwork(routerBaseUrl, workspaceRoot);
  }
  const configuredMcp = merged.mcp && typeof merged.mcp === "object" ? merged.mcp : {};
  for (const [id, server] of Object.entries(configuredMcp)) {
    if (server && server.type === "remote" && typeof server.url === "string") {
      await authorizeRuntimeNetwork(server.url, workspaceRoot);
    }
  }
  applyRuntimePermissionPolicy(merged, policy);
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(merged) };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForRuntime(url, child) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("The local AI runtime exited during startup. Check that this Axiom build is compatible with your system.");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Axiom's local runtime did not start within 45 seconds.");
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog({
    title: "Choose a project to open in Axiom",
    message: "Axiom works directly on a project folder you choose.",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

async function startRuntime(workspace) {
  const port = await findFreePort();
  let executable;
  try {
    executable = await runtimeExecutable();
    await appendRuntimeLog(`Launching Axiom local runtime from ${executable}`);
  } catch (error) {
    await appendRuntimeLog(`Runtime executable lookup failed: ${error.stack || error.message}`);
    throw error;
  }
  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
  const runtimeEnvironment = createRuntimeEnvironment(process.env, app.getPath("userData"));
  await appendRuntimeLog(`Runtime data isolation: APPDATA=${runtimeEnvironment.APPDATA}; XDG_DATA_HOME=${runtimeEnvironment.XDG_DATA_HOME}`);
  await stopRuntimeNetworkProxy();
  runtimeNetworkProxy = createNetworkPolicyProxy({
    authorize: request => authorizeRuntimeNetwork(request.url, workspace)
  });
  let proxyEnvironment;
  let runtimeConfiguration;
  try {
    proxyEnvironment = await runtimeNetworkProxy.start();
    runtimeConfiguration = await runtimeConfigurationEnvironment(workspace);
  } catch (error) {
    await stopRuntimeNetworkProxy();
    throw error;
  }
  try {
    runtimeProcess = spawn(executable, args, {
      cwd: workspace,
      windowsHide: true,
      // Native .exe paths must bypass cmd.exe. In particular, shell:true splits
      // "C:\\Program Files\\..." and makes Windows try to execute "C:\\Program".
      shell: process.platform === "win32" && /\\.(cmd|bat)$/i.test(executable),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...runtimeEnvironment, ...runtimeConfiguration, ...proxyEnvironment }
    });
  } catch (error) {
    await stopRuntimeNetworkProxy();
    throw error;
  }

  let recentOutput = "";
  const collect = chunk => {
    recentOutput = (recentOutput + chunk.toString()).slice(-6000);
  };
  runtimeProcess.stdout?.on("data", chunk => { collect(chunk); void appendRuntimeLog(chunk.toString().trimEnd()); });
  runtimeProcess.stderr?.on("data", chunk => { collect(chunk); void appendRuntimeLog(chunk.toString().trimEnd()); });
  runtimeProcess.on("error", error => {
    void stopRuntimeNetworkProxy();
    void appendRuntimeLog(`Runtime process error: ${error.stack || error.message}`);
    if (mainWindow && !mainWindow.isDestroyed() && !isQuitting) {
      void dialog.showMessageBox(mainWindow, { type: "error", title: "Axiom runtime error", message: "Axiom could not launch its local AI runtime.", detail: `${error.message}\n\nRuntime log: ${path.join(app.getPath("userData"), "logs", "runtime.log")}\n\nRestart Axiom after reviewing the log.`, buttons: ["OK"] });
    }
  });
  runtimeProcess.on("exit", (code, signal) => {
    void stopRuntimeNetworkProxy();
    void appendRuntimeLog(`Runtime exited (code=${code}, signal=${signal || "none"}).`);
    if (!isQuitting && !stoppingRuntime && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Axiom runtime stopped",
        message: "The local AI runtime has stopped unexpectedly.",
        detail: `Exit code: ${code ?? "unknown"}\nSignal: ${signal || "none"}\n\nYour project files are still on disk. Restart Axiom to reconnect. Diagnostics: ${path.join(app.getPath("userData"), "logs", "runtime.log")}`,
        buttons: ["Restart Axiom", "Quit"],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (isQuitting) return;
        isQuitting = true;
        if (response === 0) {
          app.relaunch({ args: [...process.argv.slice(1).filter(arg => !arg.startsWith("--axiom-workspace=")), `--axiom-workspace=${selectedWorkspace || ""}`] });
        }
        app.quit();
      }).catch(error => { void appendRuntimeLog(`Runtime-exit dialog failed: ${error.message}`); });
    }
  });

  const url = "http://127.0.0.1:" + port;
  try {
    await waitForRuntime(url, runtimeProcess);
  } catch (error) {
    await appendRuntimeLog(`Runtime startup failed: ${error.stack || error.message}`);
    await stopRuntime();
    const detail = recentOutput.trim();
    throw new Error(error.message + (detail ? "\n\nRecent runtime output:\n" + detail : "") + "\n\nA diagnostic log was saved in Axiom’s user-data folder.");
  }
  await appendRuntimeLog("Runtime ready at " + url);
  return url;
}

async function createWindow() {
  const requestedWorkspace = workspaceArgument();
  let workspace = requestedWorkspace && fs.existsSync(requestedWorkspace) && fs.statSync(requestedWorkspace).isDirectory()
    ? requestedWorkspace
    : null;
  if (!workspace && !requestedWorkspace) {
    const choice = await dialog.showMessageBox({
      type: "info",
      title: "Welcome to Axiom",
      message: "Welcome to Axiom",
      detail: "Start with a project folder, or open Axiom first and connect a project when you are ready.",
      buttons: ["Open Project", "Continue to Welcome", "Quit"],
      defaultId: 1,
      cancelId: 2
    });
    if (choice.response === 0) workspace = await chooseWorkspace();
    if (choice.response === 2) { app.quit(); return; }
    // Cancelling the folder picker means "not now", not "quit". The welcome
    // workspace is deliberately project-free so users can enter Axiom first.
  }
  const hasProject = !!workspace;
  const runtimeWorkspace = hasProject
    ? path.resolve(workspace)
    : path.join(app.getPath("userData"), "welcome-workspace");
  if (!hasProject) await fs.promises.mkdir(runtimeWorkspace, { recursive: true });
  selectedWorkspace = hasProject ? runtimeWorkspace : null;
  if (selectedWorkspace) {
    await currentWorkerStateStore().recoverInterrupted();
    terminalRunner = createTerminalRunner({ workspaceRoot: selectedWorkspace });
  }
  if (omniRouteManager) {
    try { await omniRouteManager.startIfConfigured(); }
    catch (error) { await appendRuntimeLog("OmniRoute auto-start failed: " + (error instanceof Error ? error.message : String(error))); }
  }
  let serverUrl;
  while (!serverUrl) {
    try {
      serverUrl = await startRuntime(runtimeWorkspace);
    } catch (error) {
      const choice = await dialog.showMessageBox({
        type: "error",
        title: "Axiom could not start",
        message: "Axiom could not start its local AI runtime.",
        detail: `${error.message}\n\nRuntime log: ${path.join(app.getPath("userData"), "logs", "runtime.log")}\n\nYou can retry startup, choose a different project, or quit. No project files have been changed by this startup attempt.`,
        buttons: ["Retry", "Choose Another Project", "Quit"],
        defaultId: 0,
        cancelId: 2
      });
      if (choice.response === 0) continue;
      if (choice.response === 1) {
        const nextWorkspace = await chooseWorkspace();
        if (nextWorkspace) {
          workspace = path.resolve(nextWorkspace);
          selectedWorkspace = workspace;
          await fs.promises.mkdir(workspace, { recursive: true });
          terminalRunner = createTerminalRunner({ workspaceRoot: workspace });
          await currentWorkerStateStore().recoverInterrupted();
          continue;
        }
      }
      app.quit();
      return;
    }
  }

  activeRuntimeUrl = serverUrl;
  openCodeTelemetryBridge = createOpenCodeTelemetryBridge({
    telemetry: executionTelemetry,
    onMetric: metric => {
      void appendRuntimeLog("Model request completed: provider=" + metric.providerId + " model=" + metric.modelId + " durationMs=" + metric.durationMs + " inputTokens=" + metric.inputTokens + " outputTokens=" + metric.outputTokens + ".");
      if (selectedWorkspace) {
        const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
        void currentExecutionArtifactStore().put({ projectId, kind: "report", name: "Model request " + metric.id, data: JSON.stringify(metric), metadata: { producer: "model-telemetry", providerId: metric.providerId, modelId: metric.modelId } }).catch(error => appendRuntimeLog("Model telemetry artifact persistence failed: " + redactSecrets(error?.message || error).slice(0, 300)));
      }
    },
    onError: error => { void appendRuntimeLog("OpenCode telemetry stream error: " + redactSecrets(error?.message || error).slice(0, 300)); }
  });
  openCodeTelemetryBridge.start(activeRuntimeUrl);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: "Axiom",
    backgroundColor: "#101116",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Capture the failure modes that commonly produce a blank packaged window.
  // Strip query/hash data because loadFile query parameters can contain workspace paths.
  const diagnosticUrl = value => {
    try { const parsed = new URL(value); parsed.search = ""; parsed.hash = ""; return parsed.toString(); }
    catch { return String(value || "").split(/[?#]/, 1)[0].slice(0, 500); }
  };
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    void appendRuntimeLog(
      `Renderer load failed (code=${errorCode}, mainFrame=${Boolean(isMainFrame)}): ${String(errorDescription || "unknown").slice(0, 300)}; URL=${diagnosticUrl(validatedURL)}`
    );
  });
  mainWindow.webContents.on("console-message", (_event, detailsOrLevel, message, line, sourceId) => {
    // Electron changed this event from positional arguments to a details object.
    const details = detailsOrLevel && typeof detailsOrLevel === "object"
      ? detailsOrLevel
      : { level: detailsOrLevel, message, lineNumber: line, sourceId };
    const text = String(details.message || "").replace(/[\\r\\n\\t]+/g, " ").slice(0, 800);
    if (!text) return;
    void appendRuntimeLog(
      `Renderer console (level=${details.level ?? "unknown"}): ${text} at ${diagnosticUrl(details.sourceId || "")}:${details.lineNumber ?? details.line ?? 0}`
    );
  });
  mainWindow.webContents.once("did-finish-load", () => {
    void appendRuntimeLog("Axiom renderer loaded.");
    // A loaded HTML document can still be a black window if the bundled UI assets
    // failed to load or the Solid application never mounted. Verify the root is populated.
    void mainWindow?.webContents.executeJavaScript(
      "({ rootFound: !!document.getElementById('root'), mounted: !!document.getElementById('root')?.children.length, title: document.title })"
    ).then((state) => {
      if (state?.mounted) {
        return appendRuntimeLog("Axiom UI mounted.");
      }
      return appendRuntimeLog("Axiom UI mount failed: " + JSON.stringify(state));
    }).catch((error) => appendRuntimeLog("Axiom UI mount check failed: " + String(error)));
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => { void appendRuntimeLog("Renderer process exited: " + JSON.stringify(details)); });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { for (const entry of browserSessions.values()) { try { entry.window.close(); } catch {} } browserSessions.clear(); mainWindow = null; });
  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, "out", "src", "webview", "standalone.html")
    : path.join(__dirname, "..", "out", "src", "webview", "standalone.html");
  await mainWindow.loadFile(htmlPath, {
    query: {
      serverUrl,
      workspaceRoot: selectedWorkspace || ""
    }
  });
}


function sendHostMessage(event, message) {
  if (!event.sender.isDestroyed()) event.sender.send("axiom:host-message", message);
}

function insidePath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function validateWorkspace(candidate) {
  if (!selectedWorkspace || path.resolve(candidate || "") !== path.resolve(selectedWorkspace)) {
    throw new Error("The requested workspace does not match the project folder selected in Axiom.");
  }
}

async function gitRoot(directory) {
  const result = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { timeout: 15000, windowsHide: true });
  return path.resolve(result.stdout.trim());
}

async function run(command, args, cwd, timeout = 120000) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    return { exitCode: 0, output: (result.stdout + result.stderr).slice(-12000) };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      output: ((error.stdout || "") + (error.stderr || "") + "\n" + (error.message || "")).slice(-12000)
    };
  }
}

async function changedFiles(worktree) {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: worktree, timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8"
    });
    return parseGitStatusPorcelainZ(result.stdout);
  } catch (error) {
    throw new Error("Git status failed: " + String(error.stderr || error.message || error).slice(-4000));
  }
}

async function headBlobSha(directory, relativePath) {
  const result = await run("git", ["ls-tree", "-z", "HEAD", "--", ":(literal)" + relativePath], directory);
  if (result.exitCode !== 0) throw new Error(result.output || "Could not inspect repository file revision.");
  const entry = result.output.split("\0").find(Boolean);
  if (!entry) return null;
  const metadata = entry.split("\t", 1)[0].split(" ");
  return metadata[1] === "blob" ? metadata[2] : null;
}

async function inspectWorktree(event, message) {
  try {
    validateWorkspace(message.workspaceRoot);
    const root = await gitRoot(message.workspaceRoot);
    const taskRoot = await gitRoot(message.worktreePath);
    if (root !== taskRoot) throw new Error("Task worktree belongs to a different Git repository.");
    const files = await changedFiles(message.worktreePath);
    const diff = await run("git", ["diff", "--no-ext-diff", "--no-renames", "HEAD", "--"], message.worktreePath);
    if (diff.exitCode !== 0) throw new Error(diff.output || "Could not read the actual Git diff.");
    let patch = diff.output;
    for (const file of files.filter(item => item.status === "??")) {
      try {
        const full = await resolveSafeWorkspaceFile(message.worktreePath, file.path);
        const inspected = await readRegularFileNoFollow(full, 1024 * 1024);
        patch += "\n\n--- NEW FILE: " + file.path + " ---\n";
        patch += inspected.size > 1024 * 1024
          ? "[Preview omitted: untracked file exceeds the 1 MiB review-preview limit.]"
          : inspected.content.toString("utf8").slice(0, 30000);
      } catch (error) {
        patch += "\n\n--- UNREADABLE NEW FILE: " + file.path + " ---\n" + String(error.message || error).slice(0, 500);
      }
    }
    const whitespace = await run("git", ["diff", "--check", "HEAD", "--"], message.worktreePath);
    sendHostMessage(event, {
      type: "agent-worktree-review-result",
      taskId: message.taskId,
      ok: true,
      changedFiles: files,
      patch: patch.slice(0, 180000),
      whitespaceCheck: { passed: whitespace.exitCode === 0, output: whitespace.output || "No whitespace errors reported by git diff --check." }
    });
  } catch (error) {
    sendHostMessage(event, { type: "agent-worktree-review-result", taskId: message.taskId, ok: false, error: error.message });
  }
}

async function persistQualityGateArtifact(message, report) {
  if (!selectedWorkspace || path.resolve(String(message.workspaceRoot || "")) !== path.resolve(selectedWorkspace)) return;
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const checks = Array.isArray(report.checks) ? report.checks.slice(0, 40).map(check => ({
    name: redactSecrets(String(check.name || "Verification check")).slice(0, 160),
    command: redactSecrets(String(check.command || "")).slice(0, 500),
    state: String(check.state || "unverified").slice(0, 32),
    exitCode: Number.isInteger(check.exitCode) ? check.exitCode : null,
    output: redactSecrets(String(check.output || "")).slice(0, 64 * 1024)
  })) : [];
  const data = redactSecrets(JSON.stringify({
    status: String(report.status || "Blocked").slice(0, 80),
    ranProjectCheck: report.ranProjectCheck === true,
    checks
  })).slice(0, 512 * 1024);
  await currentExecutionArtifactStore().put({
    projectId,
    taskId: typeof message.taskId === "string" ? message.taskId : null,
    kind: "report",
    name: "Quality gate " + String(message.taskId || message.requestId || "verification").slice(0, 120),
    data,
    metadata: {
      producer: "quality-gate",
      requestId: String(message.requestId || "").slice(0, 160),
      status: String(report.status || "Blocked").slice(0, 80),
      checkCount: checks.length,
      passedCount: checks.filter(check => check.state === "passed").length,
      capturedAt: Date.now()
    }
  });
}

async function runQualityGate(event, message) {
  const checks = [];
  const addCheck = async (name, command, args, cwd, timeout) => {
    const result = await run(command, args, cwd, timeout);
    checks.push({ name, command: [command, ...args].join(" "), state: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, output: result.output || "Command completed without output." });
  };
  try {
    validateWorkspace(message.workspaceRoot);
    const root = await gitRoot(message.workspaceRoot);
    if (await gitRoot(message.worktreePath) !== root) throw new Error("Task worktree belongs to a different Git repository.");
    if (message.forceIntegration === true) await appendRuntimeLog(`User requested force integration for task ${String(message.taskId || "unknown")} (quality-gate bypass only).`);
    const paths = Array.isArray(message.changedPaths)
      ? message.changedPaths.map(normalizeWorkspaceRelativePath)
      : [];
    for (const relative of paths) await resolveSafeWorkspaceFile(message.worktreePath, relative);
    await addCheck("Git whitespace and conflict-marker check", "git", ["diff", "--check", "HEAD", "--"], message.worktreePath, 30000);

    const untracked = (await changedFiles(message.worktreePath)).filter(file => file.status === "??");
    const untrackedIssues = [];
    for (const file of untracked) {
      try {
        const full = await resolveSafeWorkspaceFile(message.worktreePath, file.path);
        const inspected = await readRegularFileNoFollow(full, 5 * 1024 * 1024);
        const lines = inspected.content.toString("utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/[ \t]+$/.test(line)) untrackedIssues.push(file.path + ":" + (index + 1) + ": trailing whitespace");
          if (/^(<<<<<<< |=======|>>>>>>> )/.test(line)) untrackedIssues.push(file.path + ":" + (index + 1) + ": possible unresolved conflict marker");
        });
      } catch (error) {
        untrackedIssues.push(file.path + ": unable to inspect file safely: " + String(error.message || error).slice(0, 300));
      }
    }
    checks.push({
      name: "Untracked file whitespace and conflict-marker check",
      state: untrackedIssues.length ? "failed" : "passed",
      exitCode: untrackedIssues.length ? 1 : 0,
      output: untrackedIssues.join("\n") || "No whitespace issues or common conflict markers found in untracked files."
    });

    const packageFile = path.join(message.worktreePath, "package.json");
    let manifest = null;
    try { manifest = JSON.parse(await fs.promises.readFile(packageFile, "utf8")); } catch {}
    const testPaths = paths.filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
      && fs.existsSync(path.resolve(message.worktreePath, file)));
    const lockName = fs.existsSync(path.join(message.worktreePath, "pnpm-lock.yaml")) ? "pnpm" :
      fs.existsSync(path.join(message.worktreePath, "yarn.lock")) ? "yarn" : "npm";
    if (testPaths.length && manifest) {
      const command = lockName === "pnpm" ? "pnpm" : lockName === "yarn" ? "yarn" : "npm";
      const args = lockName === "npm"
        ? ["exec", "--", "vitest", "run", ...testPaths]
        : lockName === "yarn" ? ["vitest", "run", ...testPaths] : ["exec", "vitest", "run", ...testPaths];
      await addCheck("Targeted unit tests", command, args, message.worktreePath, 180000);
    }
    const sourceChanged = paths.some(file => /\.(tsx?|jsx?)$/.test(file) && !/(\.test|\.spec)\./.test(file));
    if (sourceChanged && manifest?.scripts?.build) {
      const command = lockName === "pnpm" ? "pnpm" : lockName === "yarn" ? "yarn" : "npm";
      const args = lockName === "npm" ? ["run", "build"] : ["run", "build"];
      await addCheck("Project build", command, args, message.worktreePath, 240000);
    }

    const ranProjectCheck = checks.some(check => check.name === "Targeted unit tests" || check.name === "Project build");
    if (!ranProjectCheck) {
      checks.push({
        name: "Project-level verification evidence",
        state: "unverified",
        output: "No targeted test file or project build script was available. Automatic integration is blocked; use explicit force review only after inspecting the actual diff."
      });
    }
    const status = resolveWorkerQualityStatus(checks, ranProjectCheck);
    const failed = status !== "Ready to review";
    const historyStatus = failed ? "failed" : "verified";
    await currentProjectStore().addChange({
      title: "Automated verification run",
      summary: checks.length + " checks recorded; " + checks.filter(check => check.state === "passed").length + " passed, " + checks.filter(check => check.state !== "passed").length + " failed. " + (ranProjectCheck ? "A project-level test or build command ran." : "No project-level test or build command was available for this change."),
      status: historyStatus,
      checks: checks.map(check => ({ name: check.name, state: check.state === "passed" ? "passed" : "failed", details: "Exit code: " + check.exitCode + ". Full output is available in the verification panel." })),
      files: Array.isArray(message.changedPaths) ? message.changedPaths : []
    });
    try { await persistQualityGateArtifact(message, { status, checks, ranProjectCheck }); }
    catch (artifactError) { await appendRuntimeLog("Could not persist quality-gate artifact: " + redactSecrets(artifactError?.message || artifactError).slice(0, 400)); }
    sendHostMessage(event, { type: "agent-quality-gate-result", taskId: message.taskId, requestId: message.requestId, status, checks, ranProjectCheck });
    sendHostMessage(event, { type: "project-state-updated" });
  } catch (error) {
    try {
      await currentProjectStore().addChange({
        title: "Automated verification blocked",
        summary: "Verification could not complete: " + String(error.message || error).slice(0, 500),
        status: "failed",
        checks: checks.map(check => ({ name: check.name, state: check.state === "passed" ? "passed" : "failed", details: "Exit code: " + check.exitCode + ". Full output is available in the verification panel." }))
      });
      sendHostMessage(event, { type: "project-state-updated" });
    } catch { /* A history write failure must not hide the verification error. */ }
    try { await persistQualityGateArtifact(message, { status: "Blocked", checks }); }
    catch (artifactError) { await appendRuntimeLog("Could not persist blocked quality-gate artifact: " + redactSecrets(artifactError?.message || artifactError).slice(0, 400)); }
    sendHostMessage(event, { type: "agent-quality-gate-result", taskId: message.taskId, requestId: message.requestId, status: "Blocked", checks, error: error.message });
  }
}

async function upstreamRevision(root) {
  const upstream = await run("git", ["rev-parse", "--symbolic-full-name", "@{u}"], root, 15000);
  if (upstream.exitCode !== 0 || !upstream.output.trim()) {
    const remotes = await run("git", ["remote"], root, 15000);
    if (remotes.exitCode !== 0) throw new Error("Could not determine whether this workspace has a remote repository. " + remotes.output);
    if (remotes.output.trim()) throw new Error("Remote drift check cannot run because this branch has no upstream tracking branch. Configure an upstream before integrating worker changes.");
    return null;
  }
  const ref = upstream.output.trim().split(/\r?\n/).at(-1);
  const prefix = "refs/remotes/";
  if (!ref.startsWith(prefix) || !ref.slice(prefix.length).includes("/")) throw new Error("Cannot safely identify the workspace remote tracking branch: " + ref);
  const remote = ref.slice(prefix.length).split("/")[0];
  const branch = ref.slice(prefix.length + remote.length + 1);
  const fetched = await run("git", ["fetch", "--quiet", "--no-tags", remote, branch], root, 90000);
  if (fetched.exitCode !== 0) throw new Error("Remote drift check could not refresh " + ref + ". Integration is blocked to avoid overwriting remote work. " + fetched.output);
  const revision = await run("git", ["rev-parse", "--verify", ref], root, 15000);
  if (revision.exitCode !== 0) throw new Error("Remote drift check could not resolve " + ref + ". " + revision.output);
  return { ref, sha: revision.output.trim().split(/\r?\n/).at(-1) };
}
async function blobAtRevision(root, revision, relativePath) {
  const result = await run("git", ["rev-parse", "--verify", revision + ":" + relativePath], root, 15000);
  if (result.exitCode === 0) return result.output.trim().split(/\r?\n/).at(-1);
  if (/Needed a single revision|unknown revision|invalid object name|does not exist/.test(result.output)) return null;
  throw new Error("Could not compare remote file revision for " + relativePath + ". " + result.output);
}
async function applyWorktreeChanges(event, message) {
  const appliedPaths = [];
  try {
    validateWorkspace(message.workspaceRoot);
    const root = await gitRoot(message.workspaceRoot);
    await withWorkspaceIntegrationLock(root, async () => {
      if (await gitRoot(message.worktreePath) !== root) throw new Error("Task worktree belongs to a different Git repository.");
      if (!Array.isArray(message.paths) || message.paths.length > 100) throw new Error("Select between 1 and 100 files to integrate.");
      const requested = [...new Set(message.paths.map(normalizeWorkspaceRelativePath))];
      const ownership = ownershipForWorkspace(root).validateChanges(message.taskId, requested);
      if (!ownership.allowed) throw new Error("Worker attempted to integrate files outside its assigned ownership: " + ownership.violations.join(", "));
      if (!requested.length) throw new Error("Select at least one file to integrate.");
      const pathKeys = requested.map(value => process.platform === "win32" ? value.toLowerCase() : value);
      if (new Set(pathKeys).size !== pathKeys.length) throw new Error("The selection contains duplicate paths after normalization.");
      const upstream = await upstreamRevision(root);
      const staged = [];
      const maxFileBytes = 25 * 1024 * 1024;
      const maxTransactionBytes = 100 * 1024 * 1024;
      let stagedBytes = 0;

      // Validate every source and destination before writing any project file.
      for (const relative of requested) {
        const source = await resolveSafeWorkspaceFile(message.worktreePath, relative);
        const destination = await resolveSafeWorkspaceFile(root, relative);
        const dirty = await run("git", ["status", "--porcelain", "--", ":(literal)" + relative], root);
        if (dirty.exitCode !== 0) throw new Error("Could not inspect destination changes for " + relative + ". " + dirty.output);

        const taskBaseBlob = await headBlobSha(message.worktreePath, relative);
        const workspaceHeadBlob = await headBlobSha(root, relative);
        let destinationStat = null;
        try { destinationStat = await fs.promises.lstat(destination); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (destinationStat?.isSymbolicLink() || (destinationStat && !destinationStat.isFile())) {
          throw new Error("Integration blocked for " + relative + ": destination is not a regular file.");
        }
        const drift = classifyWorkspaceDrift({
          taskBaseBlob,
          workspaceHeadBlob,
          destinationDirty: !!dirty.output.trim(),
          destinationExists: !!destinationStat
        });
        if (!drift.safe) throw new Error("Integration blocked for " + relative + ": " + drift.reason + " Refresh the diff and reconcile the local and worker versions before integrating.");
        if (upstream && await blobAtRevision(root, upstream.ref, relative) !== workspaceHeadBlob) {
          throw new Error("Integration blocked for " + relative + ": remote branch " + upstream.ref + " contains a different revision. Fetch/pull and reconcile before integrating.");
        }

        let content = null;
        let sourceMode = null;
        try {
          const sourceStat = await fs.promises.lstat(source);
          if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error("Integration blocked for " + relative + ": only regular, non-symlink files can be integrated.");
          if (sourceStat.size > maxFileBytes) throw new Error("Integration blocked for " + relative + ": file exceeds the 25 MiB per-file integration limit.");
          const sourceFile = await readRegularFileNoFollow(source, maxFileBytes);
          if (sourceFile.dev !== sourceStat.dev || sourceFile.ino !== sourceStat.ino) throw new Error("Integration blocked for " + relative + ": worker source changed during preflight.");
          if (sourceFile.size > maxFileBytes) throw new Error("Integration blocked for " + relative + ": file grew beyond the per-file integration limit during preflight.");
          content = sourceFile.content;
          stagedBytes += content.length;
          sourceMode = sourceFile.mode;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (taskBaseBlob == null) throw new Error("Integration blocked for " + relative + ": worker source is missing and this is not a tracked deletion.");
        }
        if (destinationStat?.size > maxFileBytes) throw new Error("Integration blocked for " + relative + ": existing destination exceeds the 25 MiB rollback limit.");
        const destinationBackup = destinationStat ? await readRegularFileNoFollow(destination, maxFileBytes) : null;
        if (destinationBackup && (destinationBackup.dev !== destinationStat.dev || destinationBackup.ino !== destinationStat.ino)) {
          throw new Error("Integration blocked for " + relative + ": destination changed during preflight.");
        }
        const backup = destinationBackup?.content ?? null;
        if (backup) {
          stagedBytes += backup.length;
          if (backup.length > maxFileBytes) throw new Error("Integration blocked for " + relative + ": existing destination exceeds the rollback limit.");
        }
        if (stagedBytes > maxTransactionBytes) throw new Error("Integration blocked: selected files exceed the 100 MiB transaction staging limit.");
        staged.push({
          relative, source, destination, content, sourceMode,
          workspaceHeadBlob,
          existed: !!destinationStat,
          backup,
          backupMode: destinationBackup?.mode ?? null,
          temporary: null
        });
      }

      // Create missing parent directories, then revalidate every path before staging.
      for (const item of staged) {
        if (item.content === null) continue;
        await fs.promises.mkdir(path.dirname(item.destination), { recursive: true });
        const checkedDestination = await resolveSafeWorkspaceFile(root, item.relative);
        if (checkedDestination !== item.destination) throw new Error("Destination path changed during integration preflight: " + item.relative);
      }
      let remoteRevalidated = false;
      const committedPaths = await applyStagedWorkspaceFiles(staged, {
        beforeApply: async item => {
          const checkedDestination = await resolveSafeWorkspaceFile(root, item.relative);
          if (checkedDestination !== item.destination) throw new Error("Destination path changed during integration: " + item.relative);
          const dirtyNow = await run("git", ["status", "--porcelain", "--", ":(literal)" + item.relative], root);
          if (dirtyNow.exitCode !== 0 || dirtyNow.output.trim()) {
            throw new Error("Integration blocked for " + item.relative + ": destination changed after preflight.");
          }
          if (await headBlobSha(root, item.relative) !== item.workspaceHeadBlob) {
            throw new Error("Integration blocked for " + item.relative + ": workspace HEAD changed after preflight.");
          }
          if (item.content === null) {
            try {
              await fs.promises.lstat(item.source);
              throw new Error("Integration blocked for " + item.relative + ": deleted worker file reappeared after preflight.");
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          } else {
            const currentSource = await readRegularFileNoFollow(item.source, maxFileBytes);
            if (!currentSource.content.equals(item.content) || currentSource.mode !== item.sourceMode) {
              throw new Error("Integration blocked for " + item.relative + ": worker source changed after preflight.");
            }
          }
          if (!remoteRevalidated) {
            remoteRevalidated = true;
            if (upstream) {
              const latestUpstream = await upstreamRevision(root);
              if (!latestUpstream || latestUpstream.ref !== upstream.ref || latestUpstream.sha !== upstream.sha) {
                throw new Error("Integration blocked: remote branch advanced during integration preflight. Refresh and review the worker diff again.");
              }
            }
          }
        }
      });
      appliedPaths.push(...committedPaths);
      ownershipForWorkspace(root).release(message.taskId);

      sendHostMessage(event, { type: "agent-worktree-apply-result", taskId: message.taskId, ok: true, appliedPaths, remoteRevision: upstream?.sha ?? null });
      if (typeof message.worktreePath === "string") {
        const base = path.resolve(app.getPath("userData"), "worktrees", path.basename(root));
        const workerPath = path.resolve(message.worktreePath);
        if (insidePath(base, workerPath) && workerPath !== base) {
          const cleanup = await run("git", ["-C", root, "worktree", "remove", "--force", workerPath], root, 60000);
          if (cleanup.exitCode !== 0) await appendRuntimeLog("Integrated task worktree cleanup failed: " + cleanup.output);
        }
      }
    });
  } catch (error) {
    if (Array.isArray(error.appliedPaths)) appliedPaths.splice(0, appliedPaths.length, ...error.appliedPaths);
    sendHostMessage(event, { type: "agent-worktree-apply-result", taskId: message.taskId, ok: false, error: error.message, appliedPaths });
  }
}

function trustedRenderer(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

async function requirePrivilegedApproval({ title, message, detail, approveLabel = "Approve" }) {
  const options = {
    type: "warning",
    title,
    message,
    detail: redactSecrets(String(detail || "")).slice(0, 3000),
    buttons: [approveLabel, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  const projectId = selectedWorkspace ? require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40) : null;
  const auditAction = "privileged." + String(title || "operation").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 72);
  currentSecurityAuditStore().record({
    action: auditAction,
    decision: result.response === 0 ? "allow" : "deny",
    reason: result.response === 0 ? "Explicit native main-process approval granted." : "Explicit native main-process approval denied or dismissed.",
    projectId,
    resource: redactSecrets(String(detail || "")).slice(0, 512)
  });
  if (result.response !== 0) {
    await appendRuntimeLog("Privileged operation denied by the user: " + title + ".");
    throw new Error("Operation cancelled: explicit main-process approval was not granted.");
  }
  await appendRuntimeLog("Privileged operation approved by the user: " + title + ".");
  return true;
}

function normalizeNetworkPolicyTarget(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 4096) throw new TypeError("A valid network destination is required.");
  if (/^git@[a-z0-9.-]+:/i.test(rawUrl)) {
    const host = rawUrl.slice(4).split(":")[0].toLowerCase();
    return "https://" + host + "/";
  }
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Network destination is invalid."); }
  if (parsed.protocol === "ssh:") return "https://" + parsed.hostname + "/";
  return parsed.toString();
}

async function enforceWorkspaceNetworkApproval(rawUrl, options = {}, workspaceRoot = selectedWorkspace) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("A trusted workspace is required for outbound network access.");
  const target = normalizeNetworkPolicyTarget(rawUrl);
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 40);
  const origin = new URL(target).origin;
  const audit = currentSecurityAuditStore();
  const result = currentWorkspaceSecurityPolicyStore().evaluateNetworkRequest(workspaceRoot, target, []);
  const resource = redactSecrets(origin).slice(0, 512);
  if (result.decision === "deny") {
    audit.record({ action: "network.request", decision: "deny", reason: result.reason, projectId, resource });
    throw new Error("Workspace security policy denied outbound network access to " + origin + ".");
  }
  if (result.decision === "approval-required") {
    audit.record({ action: "network.request", decision: "approval-required", reason: result.reason, projectId, resource });
    try {
      await requirePrivilegedApproval({
        title: options.title || "Approve outbound network access",
        message: options.message || "Allow this project to connect to an external service?",
        detail: (options.detail ? options.detail + "\\n" : "") + "Destination: " + origin,
        approveLabel: options.approveLabel || "Allow connection"
      });
      audit.record({ action: "network.request", decision: "allow", reason: "User approved outbound network access.", projectId, resource });
      return true;
    } catch (error) {
      audit.record({ action: "network.request", decision: "deny", reason: "Outbound network approval was denied or dismissed.", projectId, resource });
      throw error;
    }
  }
  audit.record({ action: "network.request", decision: "allow", reason: result.reason, projectId, resource });
  return true;
}

async function authorizeRuntimeNetwork(rawUrl, workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("A trusted runtime workspace is required.");
  const target = new URL(normalizeNetworkPolicyTarget(rawUrl));
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 40);
  const record = currentWorkspaceSecurityPolicyStore().read(workspaceRoot);
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const cacheKey = projectId + ":" + target.hostname.toLowerCase() + ":" + port;
  if (runtimeNetworkApprovalCache.get(cacheKey) === record.revision) return true;
  await enforceWorkspaceNetworkApproval(target.toString(), {
    title: "Approve runtime outbound connection",
    message: "Allow the Axiom runtime or one of its managed tools to connect to this external host?",
    detail: "Runtime egress",
    approveLabel: "Allow host"
  }, workspaceRoot);
  const updated = currentWorkspaceSecurityPolicyStore().read(workspaceRoot);
  runtimeNetworkApprovalCache.set(cacheKey, updated.revision);
  return true;
}

async function stopRuntimeNetworkProxy() {
  const proxy = runtimeNetworkProxy;
  runtimeNetworkProxy = null;
  runtimeNetworkApprovalCache.clear();
  if (proxy) await proxy.stop();
}

async function enforceWorkspacePolicyApproval(action, options) {
  if (!selectedWorkspace) throw new Error("A selected project is required for this privileged operation.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const resource = redactSecrets(String(options.resource || "workspace-operation")).slice(0, 512);
  const audit = currentSecurityAuditStore();
  const policy = currentWorkspaceSecurityPolicyStore().evaluate(selectedWorkspace, action);
  if (policy.decision === "deny") {
    audit.record({ action, decision: "deny", reason: policy.reason, projectId, resource });
    throw new Error("Workspace security policy denied " + action + ".");
  }
  if (policy.decision !== "allow" && policy.decision !== "approval-required") {
    audit.record({ action, decision: "deny", reason: "Invalid workspace policy decision; operation fails closed.", projectId, resource });
    throw new Error("Workspace security policy returned an invalid decision for " + action + ".");
  }
  audit.record({ action, decision: policy.decision, reason: policy.reason, projectId, resource });
  if (policy.decision === "allow") return true;
  try {
    await requirePrivilegedApproval(options);
    audit.record({ action, decision: "allow", reason: "User approved operation under workspace policy.", projectId, resource });
    return true;
  } catch (error) {
    audit.record({ action, decision: "deny", reason: "Native approval was denied or dismissed.", projectId, resource });
    throw error;
  }
}

function currentProjectStore() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return createProjectStore(app.getPath("userData"), selectedWorkspace);
}
function currentWorkerStateStore() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return createWorkerStateStore(app.getPath("userData"), selectedWorkspace);
}
function currentExecutionLedger() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return createExecutionLedger(app.getPath("userData"), selectedWorkspace);
}
function currentProviderCredentialManager() {
  return createProviderCredentialManager(currentSecureCredentialStore());
}
function currentProjectKnowledgeStore() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return createProjectKnowledgeStore({ userDataPath: app.getPath("userData"), workspaceRoot: selectedWorkspace });
}
function currentExecutionArtifactStore() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  return createExecutionArtifactStore({ root: path.join(app.getPath("userData"), "execution-artifacts") });
}

ipcMain.handle("axiom:mcp-diagnostics", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const status = mcpManager.getStatus();
  const diagnostics = await inspectMcpRuntime({
    baseUrl: activeRuntimeUrl,
    configuredIds: status.filter(item => item.enabled).map(item => item.id)
  });
  return { ...diagnostics, integrations: status };
});

ipcMain.handle("axiom:mcp-worker-probe", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (typeof id !== "string") throw new Error("Invalid MCP integration ID.");
  const entry = mcpManager.getStatus().find(item => item.id === id);
  if (!entry || !entry.enabled) throw new Error("Enable this integration and restart Axiom before testing a worker tool call.");
  if (!selectedWorkspace) throw new Error("Open a project before probing an MCP tool.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const audit = currentSecurityAuditStore();
  const policy = currentWorkspaceSecurityPolicyStore().evaluate(selectedWorkspace, "mcp.invoke");
  const resource = "integration:" + entry.id;
  if (policy.decision === "deny") {
    audit.record({ action: "mcp.invoke", decision: "deny", reason: policy.reason, projectId, resource });
    throw new Error("Workspace security policy denied MCP tool invocation.");
  }
  if (policy.decision !== "approval-required") {
    audit.record({ action: "mcp.invoke", decision: "deny", reason: "Invalid MCP policy decision; invocation fails closed.", projectId, resource });
    throw new Error("Workspace security policy returned an invalid MCP decision.");
  }
  audit.record({ action: "mcp.invoke", decision: "approval-required", reason: policy.reason, projectId, resource });
  try {
    await requirePrivilegedApproval({
      title: "Approve MCP tool probe",
      message: "Allow Axiom to create a model session and invoke a tool from this integration?",
      detail: "Integration: " + entry.name + " (" + entry.id + ")\\nRisk: " + entry.riskLabel,
      approveLabel: "Run tool probe"
    });
    audit.record({ action: "mcp.invoke", decision: "allow", reason: "User approved MCP tool probe.", projectId, resource });
  } catch (error) {
    audit.record({ action: "mcp.invoke", decision: "deny", reason: "MCP tool probe approval was denied or dismissed.", projectId, resource });
    throw error;
  }
  const taskId = "mcp-probe-" + require("node:crypto").randomUUID();
  const taskStore = currentWorkerStateStore();
  await taskStore.record({ taskId, title: "MCP tool verification: " + entry.name, status: "running", workerType: "mcp-diagnostic", integrationId: id, startedAt: Date.now() });
  try {
    const result = await runWorkerToolProbe({ baseUrl: activeRuntimeUrl, integrationId: id });
    await taskStore.record({
      taskId, title: "MCP tool verification: " + entry.name,
      status: result.invoked ? "succeeded" : "failed", workerType: "mcp-diagnostic",
      integrationId: id, sessionId: result.sessionId, toolName: result.toolName,
      error: result.invoked ? undefined : result.message, finishedAt: Date.now()
    });
    sendHostMessage(event, { type: "worker-state-updated" });
    void appendRuntimeLog("MCP worker probe for " + id + " finished with status=" + result.status + (result.toolName ? " tool=" + result.toolName : "") + ".");
    return result;
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error || "Unknown runtime error")
      .replace(/[\\r\\n\\t]+/g, " ")
      .slice(0, 500);
    const diagnostic = "MCP worker probe failed: " + (detail || "Unknown runtime error.");
    await taskStore.record({
      taskId, title: "MCP tool verification: " + entry.name, status: "failed",
      workerType: "mcp-diagnostic", integrationId: id,
      sessionId: typeof error?.sessionId === "string" ? error.sessionId : undefined,
      error: diagnostic, finishedAt: Date.now(),
      logs: [diagnostic]
    });
    await appendRuntimeLog("MCP worker probe for " + id + " failed: " + detail);
    sendHostMessage(event, { type: "worker-state-updated" });
    throw error;
  }
});

ipcMain.handle("axiom:mcp-status", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return mcpManager.getStatus();
});

ipcMain.handle("axiom:mcp-save-secret", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string" || typeof request.secret !== "string" || !request.secret.trim()) throw new Error("Invalid MCP credential request.");
  const integration = mcpManager.getStatus().find(item => item.id === request.id);
  if (!integration) throw new Error("Unknown MCP integration.");
  await requirePrivilegedApproval({
    title: "Approve MCP credential storage",
    message: "Store an encrypted credential for this MCP integration?",
    detail: "Integration: " + integration.name + " (" + integration.id + ")\\nThe credential value is excluded from this confirmation and audit record.",
    approveLabel: "Store credential"
  });
  const result = mcpManager.saveSecret(request.id, request.secret);
  await appendRuntimeLog("Saved secure MCP credential for " + request.id + "; restart required to load the integration.");
  return result;
});

ipcMain.handle("axiom:mcp-enable", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string" || typeof request.enabled !== "boolean") throw new Error("Invalid MCP enable request.");
  if (request.enabled) {
    const integration = mcpManager.getStatus().find(item => item.id === request.id);
    if (!integration) throw new Error("Unknown MCP integration.");
    if (!selectedWorkspace) throw new Error("Open a project before enabling an MCP integration.");
    const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
    const audit = currentSecurityAuditStore();
    const policy = currentWorkspaceSecurityPolicyStore().evaluate(selectedWorkspace, "mcp.invoke");
    const resource = "integration:" + integration.id;
    if (integration.transport === "remote" && integration.endpoint) {
      await enforceWorkspaceNetworkApproval(integration.endpoint, {
        title: "Approve remote MCP network access",
        message: "Allow this MCP integration to connect to its remote service?",
        detail: "Integration: " + integration.name,
        approveLabel: "Allow MCP connection"
      });
    }
    if (policy.decision === "deny") {
      audit.record({ action: "mcp.invoke", decision: "deny", reason: policy.reason, projectId, resource });
      throw new Error("Workspace security policy denied MCP integration activation.");
    }
    if (policy.decision !== "approval-required") {
      audit.record({ action: "mcp.invoke", decision: "deny", reason: "Invalid MCP policy decision; activation fails closed.", projectId, resource });
      throw new Error("Workspace security policy returned an invalid MCP decision.");
    }
    audit.record({ action: "mcp.invoke", decision: "approval-required", reason: policy.reason, projectId, resource });
    try {
      await requirePrivilegedApproval({
        title: "Approve MCP integration",
        message: "Allow this MCP integration to start with Axiom and expose its tools to the model runtime?",
        detail: "Integration: " + integration.name + " (" + integration.id + ")\\nTransport: " + integration.transport + "\\nRisk: " + integration.riskLabel + "\\nEndpoint/package: " + String(integration.endpoint || integration.package || "managed"),
        approveLabel: "Enable integration"
      });
      audit.record({ action: "mcp.invoke", decision: "allow", reason: "User approved MCP integration activation.", projectId, resource });
    } catch (error) {
      audit.record({ action: "mcp.invoke", decision: "deny", reason: "MCP integration approval was denied or dismissed.", projectId, resource });
      throw error;
    }
  }
  const result = mcpManager.setEnabled(request.id, request.enabled);
  await appendRuntimeLog("MCP integration " + request.id + " set enabled=" + request.enabled + "; restart required.");
  return result;
});

ipcMain.handle("axiom:mcp-remove", (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const result = mcpManager.remove(id);
  void appendRuntimeLog("Removed MCP integration configuration for " + id + "; restart required.");
  return result;
});

ipcMain.handle("axiom:plugin-list", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentPluginHost().list();
});

ipcMain.handle("axiom:plugin-run", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("Open a project before running a plugin.");
  if (!request || typeof request.pluginId !== "string" || !Array.isArray(request.args || [])) throw new TypeError("Invalid plugin execution request.");
  const result = await currentPluginHost().run(request.pluginId, {
    workspaceRoot: selectedWorkspace,
    args: request.args || []
  });
  await appendRuntimeLog("Plugin " + request.pluginId + " completed in the isolated runtime.");
  return result;
});

ipcMain.handle("axiom:security-audit-list", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentSecurityAuditStore().list(200);
});

ipcMain.handle("axiom:security-audit-verify", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return { verified: true, sequence: currentSecurityAuditStore().verify() };
});

ipcMain.handle("axiom:security-policy-read", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return currentWorkspaceSecurityPolicyStore().read(selectedWorkspace);
});

ipcMain.handle("axiom:security-policy-update", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("A security policy update is required.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const audit = currentSecurityAuditStore();
  audit.record({ action: "security-policy.update", decision: "approval-required", reason: "Changing workspace security policy requires native confirmation.", projectId, resource: "workspace-policy" });
  try {
    await requirePrivilegedApproval({
      title: "Change project security policy",
      message: "Allow this change to the selected project's security policy?",
      detail: "This policy controls filesystem reads and writes, shell execution, network requests, MCP calls, Git pushes, deployments and plugin execution. More restrictive decisions may block existing workflows.",
      approveLabel: "Update policy"
    });
    const updated = currentWorkspaceSecurityPolicyStore().update(selectedWorkspace, request.policy, request.expectedRevision);
    runtimeNetworkApprovalCache.clear();
    audit.record({ action: "security-policy.update", decision: "allow", reason: "User approved a versioned workspace security policy update.", projectId, resource: "revision:" + updated.revision });
    return updated;
  } catch (error) {
    audit.record({ action: "security-policy.update", decision: "deny", reason: "Policy update was denied or rejected: " + String(error.message || error).slice(0, 300), projectId, resource: "workspace-policy" });
    throw error;
  }
});

ipcMain.handle("axiom:telemetry-snapshot", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return executionTelemetry.snapshot();
});

ipcMain.handle("axiom:omniroute-status", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return omniRouteManager.status();
});

ipcMain.handle("axiom:omniroute-check", async (event, settings) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!settings || typeof settings !== "object") throw new TypeError("Invalid OmniRoute connection settings.");
  await requirePrivilegedApproval({
    title: "Approve OmniRoute connection test",
    message: "Allow Axiom to send a connection test to this model-routing endpoint?",
    detail: "Endpoint: " + String(settings.baseUrl || "configured endpoint") + "\nThe API key is excluded from this confirmation and audit record.",
    approveLabel: "Test connection"
  });
  return omniRouteManager.checkConnection(settings);
});

ipcMain.handle("axiom:omniroute-save", async (event, settings) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new TypeError("Invalid OmniRoute settings.");
  await requirePrivilegedApproval({
    title: "Approve OmniRoute configuration",
    message: "Save this model-routing endpoint and its encrypted API credential?",
    detail: "Endpoint: " + String(settings.baseUrl || "default local endpoint") + "\nModel: " + String(settings.model || "auto") + "\nThe API key is excluded from this confirmation and audit record.",
    approveLabel: "Save routing settings"
  });
  return omniRouteManager.save(settings);
});

ipcMain.handle("axiom:omniroute-install", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  await requirePrivilegedApproval({
    title: "Approve OmniRoute installation",
    message: "Allow Axiom to download and install the OmniRoute runtime?",
    detail: "This operation installs a third-party command-line runtime on this device.",
    approveLabel: "Install OmniRoute"
  });
  return omniRouteManager.install();
});

ipcMain.handle("axiom:omniroute-start", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  await requirePrivilegedApproval({
    title: "Approve OmniRoute process startup",
    message: "Allow Axiom to start the configured local model-routing process?",
    detail: "The process will run in the background until stopped or Axiom exits.",
    approveLabel: "Start OmniRoute"
  });
  return omniRouteManager.start();
});

ipcMain.handle("axiom:omniroute-stop", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return omniRouteManager.stop();
});

ipcMain.handle("axiom:omniroute-dashboard", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const config = omniRouteManager.getConfig();
  const url = new URL(config.baseUrl);
  url.pathname = url.pathname.endsWith("/v1") ? (url.pathname.slice(0, -3) || "/") : url.pathname;
  await requirePrivilegedApproval({
    title: "Approve external dashboard",
    message: "Open the configured model-router dashboard in your default browser?",
    detail: "URL: " + url.toString(),
    approveLabel: "Open dashboard"
  });
  await shell.openExternal(url.toString());
  return true;
});





async function loadBrowserPage(browserWindow, url) {
  let timer;
  try {
    await Promise.race([
      browserWindow.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (!browserWindow.isDestroyed()) browserWindow.webContents.stop();
          reject(new Error("Browser navigation timed out after 30 seconds."));
        }, 30000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function ownedBrowserSession(event, id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("Invalid browser session ID.");
  const entry = browserSessions.get(id);
  if (!entry || entry.ownerId !== event.sender.id || entry.window.isDestroyed()) throw new Error("Browser session not found or no longer owned by this window.");
  return entry;
}
function recordBrowserError(entry, value) {
  const safe = redactSecrets(String(value || "Browser error")).replace(/[\r\n\t]+/g, " ").slice(0, 1200);
  if (!safe) return;
  entry.errors.push(safe);
  if (entry.errors.length > 40) entry.errors.splice(0, entry.errors.length - 40);
}
ipcMain.handle("axiom:browser-open", async (event, rawUrl) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const url = validateBrowserNavigation(rawUrl);
  const initialOrigin = new URL(url).origin;
  await requirePrivilegedApproval({
    title: "Approve browser network access",
    message: "Allow the isolated Axiom browser to connect to this website?",
    detail: "Origin: " + initialOrigin + "\nThe browser session is isolated from your normal browser profile.",
    approveLabel: "Open website"
  });
  const sessionId = require("node:crypto").randomUUID();
  const browserWindow = new BrowserWindow({
    parent: mainWindow, width: 1280, height: 860, minWidth: 720, minHeight: 520,
    title: "Axiom Browser", backgroundColor: "#ffffff", show: false,
    webPreferences: {
      partition: "axiom-browser-" + sessionId, contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, spellcheck: false,
    },
  });
  browserWindow.removeMenu();
  const browserProjectId = selectedWorkspace
    ? require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40)
    : null;
  const entry = { ownerId: event.sender.id, window: browserWindow, errors: [], projectId: browserProjectId, openedAt: Date.now(), initialUrl: url, approvedOrigins: new Set([initialOrigin]) };
  browserSessions.set(sessionId, entry);
  const pageSession = browserWindow.webContents.session;
  pageSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  pageSession.on("will-download", (_downloadEvent, item) => item.cancel());
  pageSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
    let decision;
    try {
      decision = selectedWorkspace
        ? currentWorkspaceSecurityPolicyStore().evaluateNetworkRequest(selectedWorkspace, details.url, [...entry.approvedOrigins])
        : { decision: "deny", reason: "No trusted workspace is selected." };
    } catch (error) {
      decision = { decision: "deny", reason: "Network policy evaluation failed: " + String(error.message || error).slice(0, 200) };
    }
    if (decision.decision === "allow") {
      callback({ cancel: false });
      return;
    }
    try {
      currentSecurityAuditStore().record({
        action: "network.request",
        decision: "deny",
        reason: decision.reason,
        projectId: entry.projectId,
        resource: (() => { try { return new URL(details.url).origin; } catch { return "invalid-origin"; } })()
      });
    } catch (error) {
      void appendRuntimeLog("Network denial audit failed closed: " + String(error.message || error).slice(0, 200));
    }
    recordBrowserError(entry, "Blocked outbound request: " + (() => { try { return new URL(details.url).origin; } catch { return "invalid destination"; } })() + ". " + decision.reason);
    callback({ cancel: true });
  });
  pageSession.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (_details) => {
    let origin = "unknown origin";
    try { origin = new URL(_details.url).origin; } catch {}
    recordBrowserError(entry, "Network request failed (" + String(_details.error || "unknown").slice(0, 120) + ") at " + origin);
  });
  pageSession.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, details => {
    if (details.statusCode >= 400) {
      let origin = "unknown origin";
      try { origin = new URL(details.url).origin; } catch {}
      recordBrowserError(entry, "Network response " + details.statusCode + " at " + origin);
    }
  });
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  browserWindow.webContents.on("will-navigate", (navigationEvent, target) => {
    navigationEvent.preventDefault();
    let origin = "unknown origin";
    try { origin = new URL(validateBrowserNavigation(target)).origin; } catch {}
    recordBrowserError(entry, "Blocked page-initiated navigation to " + origin + "; use the approved Axiom navigation control.");
  });
  browserWindow.webContents.on("will-redirect", (navigationEvent, target) => {
    let nextOrigin = "";
    let currentOrigin = "";
    try { nextOrigin = new URL(validateBrowserNavigation(target)).origin; } catch {}
    try { currentOrigin = new URL(browserWindow.webContents.getURL()).origin; } catch {}
    if (!nextOrigin || nextOrigin !== currentOrigin) {
      navigationEvent.preventDefault();
      recordBrowserError(entry, "Blocked cross-origin or unsafe browser redirect to " + (nextOrigin || "an invalid destination") + ".");
    }
  });
  browserWindow.webContents.on("console-message", (_consoleEvent, detailsOrLevel, message, line, sourceId) => {
    const details = detailsOrLevel && typeof detailsOrLevel === "object"
      ? detailsOrLevel
      : { level: detailsOrLevel, message, lineNumber: line, sourceId };
    if (details.level === "error" || details.level === 2) recordBrowserError(entry, "Console: " + String(details.message || "").slice(0, 1000));
  });
  browserWindow.webContents.on("did-fail-load", (_loadEvent, code, description, failedUrl, isMainFrame) => {
    if (code !== -3 && isMainFrame) recordBrowserError(entry, "Navigation failed (" + code + "): " + String(description || failedUrl).slice(0, 500));
  });
  browserWindow.webContents.on("render-process-gone", (_goneEvent, details) => {
    recordBrowserError(entry, "Page renderer exited: " + String(details.reason || "unknown"));
  });
  browserWindow.on("closed", () => {
    browserSessions.delete(sessionId);
    if (entry.projectId && entry.errors.length) {
      const store = createExecutionArtifactStore({ root: path.join(app.getPath("userData"), "execution-artifacts") });
      const data = redactSecrets(JSON.stringify({
        sessionId,
        openedAt: entry.openedAt,
        closedAt: Date.now(),
        initialOrigin: (() => { try { return new URL(entry.initialUrl).origin; } catch { return "unknown"; } })(),
        finalOrigin: (() => { try { return new URL(entry.window.webContents.getURL()).origin; } catch { return "unknown"; } })(),
        diagnostics: entry.errors.slice(-40)
      })).slice(0, 64 * 1024);
      void store.put({
        projectId: entry.projectId,
        kind: "log",
        name: "Browser diagnostics " + sessionId,
        data,
        metadata: { producer: "browser-session", sessionId, diagnosticCount: entry.errors.length, capturedAt: Date.now() }
      }).catch(error => appendRuntimeLog("Could not persist browser diagnostics artifact: " + redactSecrets(error?.message || error).slice(0, 400)));
    }
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === entry.ownerId) {
      mainWindow.webContents.send("axiom:browser-closed", sessionId);
    }
  });
  try {
    await loadBrowserPage(browserWindow, url);
    if (!browserWindow.isDestroyed()) browserWindow.show();
    await appendRuntimeLog("Browser intelligence opened " + new URL(url).origin + ".");
    return { sessionId, url: browserWindow.webContents.getURL(), title: browserWindow.webContents.getTitle() };
  } catch (error) {
    browserSessions.delete(sessionId);
    if (!browserWindow.isDestroyed()) browserWindow.close();
    throw new Error("Could not open browser page: " + redactSecrets(error.message || error).slice(0, 1000));
  }
});
ipcMain.handle("axiom:browser-navigate", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const entry = ownedBrowserSession(event, request?.sessionId);
  const url = validateBrowserNavigation(request.url);
  const nextOrigin = new URL(url).origin;
  const currentOrigin = (() => { try { return new URL(entry.window.webContents.getURL()).origin; } catch { return ""; } })();
  if (nextOrigin !== currentOrigin) {
    await requirePrivilegedApproval({
      title: "Approve browser navigation",
      message: "Allow the isolated browser session to connect to a different website?",
      detail: "From: " + (currentOrigin || "about:blank") + "\nTo: " + nextOrigin,
      approveLabel: "Navigate"
    });
  }
  if (nextOrigin !== currentOrigin) entry.approvedOrigins.add(nextOrigin);
  await loadBrowserPage(entry.window, url);
  return { url: entry.window.webContents.getURL(), title: entry.window.webContents.getTitle() };
});
ipcMain.handle("axiom:browser-inspect", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const entry = ownedBrowserSession(event, request?.sessionId);
  const page = await entry.window.webContents.executeJavaScript("({url:location.href,title:document.title||'',capturedAt:new Date().toISOString(),viewport:{width:innerWidth,height:innerHeight},description:document.querySelector('meta[name=description]')?.content||'',headings:Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0,80).map(n=>({level:Number(n.tagName.slice(1)),text:(n.innerText||n.textContent||'').trim().slice(0,240)})),controls:Array.from(document.querySelectorAll('button,input,textarea,select,[role=button],[role=textbox]')).slice(0,120).map(n=>({tag:n.tagName.toLowerCase(),type:n.getAttribute('type')||n.getAttribute('role')||'',label:(n.getAttribute('aria-label')||n.labels?.[0]?.innerText||n.innerText||n.textContent||'').trim().slice(0,160),placeholder:(n.getAttribute('placeholder')||'').slice(0,160),disabled:Boolean(n.disabled||n.getAttribute('aria-disabled')==='true')})),links:Array.from(document.querySelectorAll('a[href]')).slice(0,100).map(n=>({text:(n.innerText||n.textContent||'').trim().slice(0,160),href:n.href.slice(0,1000)})),text:(document.body?.innerText||'').slice(0,16000)})", true);
  return { ...page, errors: [...entry.errors] };
});
ipcMain.handle("axiom:browser-act", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const entry = ownedBrowserSession(event, request?.sessionId);
  const action = normalizeBrowserAction(request?.action);
  const result = await entry.window.webContents.executeJavaScript(buildBrowserActionScript(action), true);
  await appendRuntimeLog("Browser action " + action.type + " executed against an explicitly matched visible control.");
  return result;
});
ipcMain.handle("axiom:browser-screenshot", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const entry = ownedBrowserSession(event, request?.sessionId);
  const image = await entry.window.webContents.capturePage();
  const bytes = image.toJPEG(72);
  if (bytes.length > 5 * 1024 * 1024) throw new Error("Screenshot exceeds the 5 MiB transfer limit.");
  if (selectedWorkspace) {
    try {
      const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
      await currentExecutionArtifactStore().put({
        projectId,
        kind: "screenshot",
        name: "Browser screenshot " + request.sessionId,
        data: bytes,
        metadata: { producer: "browser", sessionId: request.sessionId, url: entry.window.webContents.getURL(), capturedAt: Date.now(), format: "jpeg" }
      });
    } catch (error) {
      await appendRuntimeLog("Could not persist browser screenshot artifact: " + redactSecrets(error?.message || error).slice(0, 500));
    }
  }
  return { dataUrl: "data:image/jpeg;base64," + bytes.toString("base64") };
});
ipcMain.handle("axiom:browser-close", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const entry = ownedBrowserSession(event, request?.sessionId);
  entry.window.close();
  browserSessions.delete(request.sessionId);
  return { closed: true };
});


ipcMain.handle("axiom:remote-worker-config", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return readRemoteWorkerSettings();
});
ipcMain.handle("axiom:remote-worker-config-save", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("Invalid remote worker configuration.");
  const savedToken = currentSecureCredentialStore().get("worker-host", "token");
  const validated = validateRemoteWorkerConfig({ ...request, token: typeof request.token === "string" && request.token.trim() ? request.token.trim() : savedToken });
  await requirePrivilegedApproval({
    title: "Approve remote worker credentials",
    message: "Save this remote worker host configuration and encrypted access token?",
    detail: "Host: " + validated.hostUrl + "\nRepository: " + validated.repositoryUrl + "\nBranch: " + validated.branch + "\nThe access token is excluded from this confirmation and audit record.",
    approveLabel: "Save remote worker"
  });
  const store = currentSecureCredentialStore();
  store.set("worker-host", "host-url", validated.hostUrl);
  store.set("worker-host", "repository-url", validated.repositoryUrl);
  store.set("worker-host", "branch", validated.branch);
  store.set("worker-host", "token", validated.token);
  store.set("worker-host", "enabled", request.enabled === true ? "true" : "false");
  return readRemoteWorkerSettings();
});
ipcMain.handle("axiom:remote-worker-test", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return createRemoteWorkerHostClientForApp().health();
});
ipcMain.handle("axiom:remote-worker-list", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return createRemoteWorkerHostClientForApp().list();
});
ipcMain.handle("axiom:remote-worker-submit", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("Open a project before submitting work to a remote worker.");
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.prompt !== "string" || !request.prompt.trim()) throw new TypeError("A remote worker task instruction is required.");
  const settings = readRemoteWorkerSettings();
  if (!settings.enabled || !settings.tokenConfigured) throw new Error("Configure and enable the remote Worker Host before submitting tasks.");
  await enforceWorkspaceNetworkApproval(settings.hostUrl, { title: "Approve remote Worker Host connection", message: "Allow this project to send a task to its configured remote Worker Host?", detail: "Remote task submission", approveLabel: "Connect and send" });
  await enforceWorkspacePolicyApproval("shell.execute", {
    title: "Approve remote worker submission",
    message: "Send this task instruction to the configured remote Worker Host?",
    detail: "Host: " + settings.hostUrl + "\\nRepository: " + settings.repositoryUrl + "\\nInstruction: " + redactSecrets(request.prompt).slice(0, 1200),
    approveLabel: "Send remote task",
    resource: "remote-worker:" + settings.hostUrl
  });
  return createRemoteWorkerHostClientForApp().submit(request);
});
ipcMain.handle("axiom:remote-worker-get", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return createRemoteWorkerHostClientForApp().get(id);
});
ipcMain.handle("axiom:remote-worker-patch", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return createRemoteWorkerHostClientForApp().getPatch(id);
});
ipcMain.handle("axiom:remote-worker-retry", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string" || typeof request.prompt !== "string" || !request.prompt.trim()) throw new TypeError("A retry requires a job ID and task instruction.");
  const settings = readRemoteWorkerSettings();
  if (!settings.enabled || !settings.tokenConfigured) throw new Error("Configure and enable the remote Worker Host before retrying tasks.");
  await enforceWorkspaceNetworkApproval(settings.hostUrl, { title: "Approve remote Worker Host connection", message: "Allow this project to retry a task through its configured remote Worker Host?", detail: "Remote task retry", approveLabel: "Connect and retry" });
  await enforceWorkspacePolicyApproval("shell.execute", {
    title: "Approve remote worker retry",
    message: "Resubmit this task instruction to the configured remote Worker Host?",
    detail: "Job: " + request.id + "\\nHost: " + settings.hostUrl + "\\nInstruction: " + redactSecrets(request.prompt).slice(0, 1200),
    approveLabel: "Retry remote task",
    resource: "remote-worker:" + settings.hostUrl
  });
  return createRemoteWorkerHostClientForApp().retry(request.id, { idempotencyKey: request.idempotencyKey, prompt: request.prompt });
});
ipcMain.handle("axiom:remote-worker-cancel", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  await createRemoteWorkerHostClientForApp().cancel(id);
  return { requested: true };
});

ipcMain.handle("axiom:remote-worker-apply-patch", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("Open a local project before importing remote worker changes.");
  const repositoryUrl = currentSecureCredentialStore().get("worker-host", "repository-url");
  const result = await applyRemoteWorkerPatch({
    workspaceRoot: selectedWorkspace,
    userDataPath: app.getPath("userData"),
    taskId: request?.taskId,
    jobId: request?.jobId,
    repositoryUrl,
    patch: request?.patch,
  });
  await appendRuntimeLog("Imported remote worker patch into an isolated local review worktree for task " + String(request.taskId) + ".");
  if (typeof request.patch === "string") {
    try {
      const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
      await currentExecutionArtifactStore().put({
        projectId,
        taskId: String(request.taskId),
        kind: "patch",
        name: "Remote worker patch " + String(request.jobId || request.taskId),
        data: request.patch,
        metadata: { producer: "remote-worker-patch-import", jobId: String(request.jobId || "").slice(0, 160), importedAt: Date.now() }
      });
    } catch (artifactError) {
      await appendRuntimeLog("Could not persist remote patch artifact: " + redactSecrets(artifactError?.message || artifactError).slice(0, 400));
    }
  }
  return result;
});

ipcMain.handle("axiom:deployment-history", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) return [];
  return createDeploymentHistoryStore(app.getPath("userData")).list(selectedWorkspace);
});
ipcMain.handle("axiom:deployment-preview", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("Open a project before creating a deployment preview.");
  if (!request || typeof request !== "object" || Array.isArray(request) || path.resolve(String(request.projectRoot || "")) !== path.resolve(selectedWorkspace)) {
    throw new Error("Deployment requests must target the currently selected project.");
  }
  await enforceWorkspacePolicyApproval("deployment.publish", { title: "Approve preview deployment", message: "Upload this project build to an external deployment provider?", detail: "Provider: " + String(request.provider || "unknown") + " | Project: " + selectedWorkspace, approveLabel: "Deploy preview", resource: "provider:" + String(request.provider || "unknown") });
  const manager = createDeploymentManager({
    getCredential: provider => currentSecureCredentialStore().get("deployment", provider),
  });
  const result = await manager.deployPreview({
    ...request,
    projectRoot: selectedWorkspace,
    target: "preview",
  });
  try { await createDeploymentHistoryStore(app.getPath("userData")).append(selectedWorkspace, result); }
  catch (historyError) { await appendRuntimeLog("Deployment succeeded but history could not be saved: " + redactSecrets(historyError.message || historyError).slice(0, 500)); }
  try {
    const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
    await currentExecutionArtifactStore().put({
      projectId,
      kind: "deployment",
      name: result.provider + " preview deployment",
      data: JSON.stringify(result),
      metadata: { producer: "deployment", provider: result.provider, status: result.status, previewUrl: result.previewUrl, finishedAt: result.finishedAt }
    });
  } catch (artifactError) {
    await appendRuntimeLog("Could not persist deployment artifact: " + redactSecrets(artifactError?.message || artifactError).slice(0, 500));
  }
  await appendRuntimeLog("Created " + result.provider + " preview deployment for " + path.basename(selectedWorkspace) + ".");
  return result;
});

ipcMain.handle("axiom:remote-workspace-create", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const validated = validateRemoteWorkspaceRequest(request);
  const temporaryRoot = path.resolve(path.join(app.getPath("userData"), "remote-workspaces"));
  const id = require("node:crypto").randomUUID();
  const workspacePath = validated.mode === "persistent"
    ? path.resolve(request.persistentPath || "")
    : path.join(temporaryRoot, id);
  if (validated.mode === "persistent" && (!request.persistentPath || workspacePath === path.parse(workspacePath).root)) {
    throw new Error("Persistent mode requires an explicit, non-root workspace path.");
  }
  await enforceWorkspaceNetworkApproval(validated.repositoryUrl, { title: "Approve Git repository connection", message: "Allow Axiom to connect to this remote Git repository?", detail: "Repository clone: " + validated.branch, approveLabel: "Connect and clone" });
  await requirePrivilegedApproval({
    title: "Approve remote repository clone",
    message: "Allow Axiom to connect to and clone this remote Git repository?",
    detail: "Repository: " + validated.repositoryUrl + "\nBranch: " + validated.branch + "\nMode: " + validated.mode,
    approveLabel: "Clone repository"
  });
  const job = {
    id, ...validated, workspacePath,
    temporaryRoot: validated.mode === "persistent" ? null : temporaryRoot,
    workspaceOwnership: validated.mode === "persistent" ? "user" : "axiom-job",
    status: "creating", remoteCommitConfirmed: false,
    verificationPassed: false, pushSucceeded: false,
    error: null, lastActivityAt: Date.now()
  };
  remoteWorkspaceJobs.set(id, job);
  await persistRemoteWorkspaceJobs();
  // Return the job immediately so the renderer can expose cancellation while
  // Git is cloning. The operation lease and destination are durable first.
  void runRemoteWorkspaceOperation(job, "clone", async signal => {
    try {
      const created = await createRemoteWorkspace(request, {
        temporaryRoot, workspacePath, signal
      });
      Object.assign(job, created, { id, error: null, interruptedOperation: null });
      return { id, status: job.status };
    } catch (error) {
      job.status = error && error.name === "AbortError" ? "clone-interrupted" : "failed";
      job.error = String(error.message || error).slice(0, 500);
      throw error;
    } finally {
      await persistRemoteWorkspaceJobs();
    }
  }).catch(error => {
    void appendRuntimeLog("Remote workspace clone " + id + " ended: " + String(error.message || error).slice(0, 500));
  });
  return { id, mode: job.mode, branch: job.branch, workspacePath: job.workspacePath, status: job.status, paths: job.paths };
});

ipcMain.handle("axiom:remote-workspace-retry-clone", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const job = remoteWorkspaceJobs.get(id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
  if (job.mode === "persistent" || job.workspaceOwnership !== "axiom-job" ||
      job.status !== "clone-interrupted" || job.interruptedOperation?.kind !== "clone") {
    throw new Error("Only an interrupted Axiom-owned temporary clone can be retried automatically. Persistent destinations are preserved for manual inspection.");
  }
  await enforceWorkspaceNetworkApproval(job.repositoryUrl, { title: "Approve Git repository connection", message: "Allow Axiom to reconnect to this remote Git repository?", detail: "Repository clone retry: " + job.branch, approveLabel: "Connect and retry" });
  await requirePrivilegedApproval({
    title: "Approve remote clone retry",
    message: "Retry connecting to and cloning the remote repository?",
    detail: "Repository: " + job.repositoryUrl + "\nBranch: " + job.branch,
    approveLabel: "Retry clone"
  });
  return runRemoteWorkspaceOperation(job, "clone", async signal => {
    job.status = "creating";
    job.error = null;
    await persistRemoteWorkspaceJobs();
    try {
      await discardInterruptedCloneWorkspace(job);
      const created = await createRemoteWorkspace({
        mode: job.mode, repositoryUrl: job.repositoryUrl,
        branch: job.branch, paths: job.paths
      }, { temporaryRoot: job.temporaryRoot, workspacePath: job.workspacePath, signal });
      Object.assign(job, created, { id: job.id, error: null, interruptedOperation: null });
      return { id: job.id, status: job.status };
    } catch (error) {
      job.status = error && error.name === "AbortError" ? "clone-interrupted" : "failed";
      job.error = String(error.message || error).slice(0, 500);
      throw error;
    } finally { await persistRemoteWorkspaceJobs(); }
  });
});

ipcMain.handle("axiom:remote-workspace-list", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return [...remoteWorkspaceJobs.values()].map(job => ({
    id: job.id, mode: job.mode, branch: job.branch, workspacePath: job.workspacePath,
    status: job.status, paths: job.paths, commitSha: job.commitSha || null, error: job.error || null, operation: job.operation || null,
    remoteCommitConfirmed: job.remoteCommitConfirmed === true,
    verificationPassed: job.verificationPassed === true, pushSucceeded: job.pushSucceeded === true,
    interruptedOperation: job.interruptedOperation || null, lastActivityAt: job.lastActivityAt || null
  }));
});

ipcMain.handle("axiom:remote-workspace-commit-push", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string" || typeof request.message !== "string" || !request.message.trim()) throw new TypeError("A remote workspace job ID and commit message are required.");
  const job = remoteWorkspaceJobs.get(request.id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
  await enforceWorkspaceNetworkApproval(job.repositoryUrl, { title: "Approve Git push network access", message: "Allow Axiom to connect to the remote Git repository to push this commit?", detail: "Branch: " + job.branch, approveLabel: "Allow Git connection" });
  await enforceWorkspacePolicyApproval("git.push", { title: "Approve Git push", message: "Commit and push this remote workspace to its configured repository?", detail: "Workspace job: " + job.id + " | Repository: " + job.repositoryUrl + " | Branch: " + job.branch + " | Commit message: " + request.message, approveLabel: "Commit and push", resource: "repository:" + job.repositoryUrl + "#" + job.branch });
  return runRemoteWorkspaceOperation(job, "commit-push", async signal => {
    try {
      const result = await commitAndPushWorkspace(job, {
        message: request.message,
        signal,
        verify: async (directory, operationSignal) => {
          await remoteGit(directory, ["diff", "--check"], { signal: operationSignal });
          return true;
        }
      });
      return { ...result, id: job.id, remoteCommitConfirmed: job.remoteCommitConfirmed };
    } finally {
      // Preserve a local commit if the process fails after commit but before push confirmation.
      await persistRemoteWorkspaceJobs();
    }
  });
});

ipcMain.handle("axiom:remote-workspace-reconcile", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const job = remoteWorkspaceJobs.get(id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
  return runRemoteWorkspaceOperation(job, "reconcile", async signal => {
    try {
      const result = await reconcileRemoteWorkspace(job, { signal });
      job.interruptedOperation = null;
      return { ...result, id: job.id, status: job.status, remoteCommitConfirmed: job.remoteCommitConfirmed === true };
    } finally { await persistRemoteWorkspaceJobs(); }
  });
});

ipcMain.handle("axiom:remote-workspace-push-recovered", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string") throw new TypeError("A remote workspace job ID is required.");
  const job = remoteWorkspaceJobs.get(request.id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
  await enforceWorkspaceNetworkApproval(job.repositoryUrl, { title: "Approve recovered Git push network access", message: "Allow Axiom to connect to the remote Git repository to push the recovered commit?", detail: "Branch: " + job.branch, approveLabel: "Allow Git connection" });
  await enforceWorkspacePolicyApproval("git.push", { title: "Approve recovered Git push", message: "Push the reconciled local commit to the remote repository?", detail: "Workspace job: " + job.id + " | Repository: " + job.repositoryUrl + " | Branch: " + job.branch, approveLabel: "Push commit", resource: "repository:" + job.repositoryUrl + "#" + job.branch });
  return runRemoteWorkspaceOperation(job, "push-recovered", async signal => {
    try {
      const result = await pushReconciledWorkspace(job, {
        signal,
        verify: async (directory, operationSignal) => {
          await remoteGit(directory, ["diff", "--check"], { signal: operationSignal });
          return true;
        }
      });
      return { ...result, id: job.id, remoteCommitConfirmed: job.remoteCommitConfirmed };
    } finally { await persistRemoteWorkspaceJobs(); }
  });
});

ipcMain.handle("axiom:remote-workspace-cancel", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (typeof id !== "string" || !remoteWorkspaceJobs.has(id)) throw new Error("Remote workspace job not found in this session.");
  return cancelRemoteWorkspaceOperation(id);
});

ipcMain.handle("axiom:remote-workspace-cleanup", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const job = remoteWorkspaceJobs.get(id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
  return runRemoteWorkspaceOperation(job, "cleanup", async () => {
    const result = await cleanupRemoteWorkspace(job, { onState: persistRemoteWorkspaceJobs });
    remoteWorkspaceJobs.delete(id);
    await persistRemoteWorkspaceJobs();
    return result;
  });
});

ipcMain.handle("axiom:terminal-run", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!terminalRunner) throw new Error("The project terminal is not ready.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  if (!request || typeof request.requestId !== "string" || typeof request.command !== "string" || !request.command.trim()) {
    throw new Error("A terminal request needs a request ID and non-empty command.");
  }
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const commandResource = redactSecrets(request.command).replace(/[\\r\\n\\t]+/g, " ").slice(0, 512);
  const shellPolicy = currentWorkspaceSecurityPolicyStore().evaluate(selectedWorkspace, "shell.execute");
  const securityAudit = currentSecurityAuditStore();
  if (shellPolicy.decision === "deny") {
    securityAudit.record({ action: "shell.execute", decision: "deny", reason: shellPolicy.reason, projectId, resource: commandResource });
    throw new Error("Workspace security policy denied terminal execution.");
  }
  if (shellPolicy.decision !== "approval-required") {
    securityAudit.record({ action: "shell.execute", decision: "deny", reason: "Invalid shell policy decision; execution fails closed.", projectId, resource: commandResource });
    throw new Error("Workspace security policy returned an invalid terminal decision.");
  }
  securityAudit.record({ action: "shell.execute", decision: "approval-required", reason: shellPolicy.reason, projectId, resource: commandResource });
  try {
    await requirePrivilegedApproval({ title: "Approve terminal command", message: "Allow this command to execute on your project?", detail: request.command, approveLabel: "Run command" });
    securityAudit.record({ action: "shell.execute", decision: "allow", reason: "User approved terminal execution.", projectId, resource: commandResource });
  } catch (error) {
    securityAudit.record({ action: "shell.execute", decision: "deny", reason: "Terminal execution approval was denied or dismissed.", projectId, resource: commandResource });
    throw error;
  }
  const startedAt = Date.now();
  const output = [];
  let outputBytes = 0;
  const maxCaptureBytes = 1024 * 1024;
  const capture = chunk => {
    const remaining = maxCaptureBytes - outputBytes;
    if (remaining <= 0) return;
    const text = redactSecrets(chunk.text).slice(0, remaining);
    if (!text) return;
    output.push("[" + chunk.stream + "] " + text);
    outputBytes += Buffer.byteLength(text, "utf8");
  };
  let result;
  let failure;
  try {
    result = await terminalRunner.run({
      requestId: request.requestId,
      command: request.command,
      cwd: request.cwd,
      onOutput: chunk => {
        capture(chunk);
        if (!event.sender.isDestroyed()) event.sender.send("axiom:terminal-output", {
          requestId: request.requestId,
          stream: chunk.stream,
          text: chunk.text
        });
      }
    });
    return result;
  } catch (error) {
    failure = redactSecrets(error?.message || error);
    throw error;
  } finally {
    try {
      const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
      await currentExecutionArtifactStore().put({
        projectId,
        taskId: typeof request.taskId === "string" ? request.taskId : null,
        kind: "log",
        name: "Terminal execution " + request.requestId,
        data: (output.join("\n") + (failure ? "\n[error] " + failure : "")).slice(0, maxCaptureBytes),
        metadata: {
          producer: "terminal",
          requestId: request.requestId,
          command: redactSecrets(request.command).slice(0, 1000),
          cwd: typeof request.cwd === "string" ? request.cwd.slice(0, 500) : "",
          startedAt,
          finishedAt: Date.now(),
          exitCode: result?.exitCode ?? null,
          signal: result?.signal ?? null,
          truncated: outputBytes >= maxCaptureBytes,
          failed: Boolean(failure)
        }
      });
    } catch (artifactError) {
      await appendRuntimeLog("Could not persist terminal execution artifact: " + redactSecrets(artifactError?.message || artifactError).slice(0, 500));
    }
  }
});

ipcMain.handle("axiom:terminal-cancel", async (event, requestId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!terminalRunner || typeof requestId !== "string") return false;
  return terminalRunner.cancel(requestId);
});

ipcMain.handle("axiom:fs-list", async (event, relativePath = "") => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  await authorizeFilesystemOperation("read", relativePath);
  return listDirectory(selectedWorkspace, relativePath);
});

ipcMain.handle("axiom:fs-read", async (event, relativePath) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  await authorizeFilesystemOperation("read", relativePath);
  return readProjectFile(selectedWorkspace, relativePath);
});

ipcMain.handle("axiom:fs-write", async (event, relativePath, content) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  await authorizeFilesystemOperation("write", relativePath);
  return writeProjectFile(selectedWorkspace, relativePath, content);
});

ipcMain.handle("axiom:project-bootstrap", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return { workspaceRoot: selectedWorkspace, appVersion: app.getVersion(), platform: process.platform };
});

ipcMain.handle("axiom:project-state-read", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectStore().read();
});
ipcMain.handle("axiom:worker-state-list", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentWorkerStateStore().list();
});
ipcMain.handle("axiom:worker-state-record", async (event, task) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const saved = await currentWorkerStateStore().record(task);
  sendHostMessage(event, { type: "worker-state-updated", task: saved });
  return saved;
});
ipcMain.handle("axiom:execution-ledger-list", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentExecutionLedger().list();
});
ipcMain.handle("axiom:execution-ledger-get", (event, objectiveId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentExecutionLedger().get(objectiveId);
});
ipcMain.handle("axiom:execution-ledger-create", (event, objective) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentExecutionLedger().create(objective);
});
ipcMain.handle("axiom:execution-ledger-commit", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("Invalid execution-ledger commit request.");
  return currentExecutionLedger().commit(request.objectiveId, request.expectedRevision, request.objective, request.event);
});
ipcMain.handle("axiom:execution-ledger-remove", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("Invalid execution-ledger removal request.");
  return currentExecutionLedger().remove(request.objectiveId, request.expectedRevision);
});
ipcMain.handle("axiom:provider-credential-status", event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return ["github", "supabase"].map(providerId => currentProviderCredentialManager().status(providerId));
});
ipcMain.handle("axiom:provider-credential-save", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("Invalid provider credential request.");
  if (!["github", "supabase"].includes(request.providerId) || typeof request.secret !== "string" || !request.secret.trim()) throw new TypeError("Invalid provider credential request.");
  await requirePrivilegedApproval({
    title: "Approve provider credential storage",
    message: "Store an encrypted provider credential for use by Axiom?",
    detail: "Provider: " + request.providerId + "\nThe credential value is intentionally excluded from this confirmation and audit record.",
    approveLabel: "Store credential"
  });
  return currentProviderCredentialManager().save(request.providerId, request.secret);
});
ipcMain.handle("axiom:provider-credential-remove", async (event, providerId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!["github", "supabase"].includes(providerId)) throw new TypeError("Unsupported provider credential.");
  await requirePrivilegedApproval({
    title: "Approve provider credential removal",
    message: "Remove the encrypted provider credential from this device?",
    detail: "Provider: " + providerId,
    approveLabel: "Remove credential"
  });
  return currentProviderCredentialManager().remove(providerId);
});

ipcMain.handle("axiom:knowledge-index-scan", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().scanWorkspace();
});
ipcMain.handle("axiom:knowledge-index-read", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().readIndex();
});
ipcMain.handle("axiom:knowledge-index-update", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request !== "object") throw new TypeError("Invalid project index update.");
  return currentProjectKnowledgeStore().updateIndex(request.changed || [], request.removed || []);
});
ipcMain.handle("axiom:knowledge-index-search", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().searchIndex(request?.query, request?.limit);
});
ipcMain.handle("axiom:knowledge-memory-read", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().readMemory();
});
ipcMain.handle("axiom:knowledge-memory-upsert", async (event, record) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().upsertMemory(record);
});
ipcMain.handle("axiom:knowledge-memory-search", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().searchMemory(request?.query, request?.limit);
});
ipcMain.handle("axiom:knowledge-memory-remove", async (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectKnowledgeStore().removeMemory(id);
});

ipcMain.handle("axiom:artifact-list", async (event, taskId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentExecutionArtifactStore().list(require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40), taskId);
});
ipcMain.handle("axiom:artifact-put", async (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request !== "object" || typeof request.data !== "string" || request.data.length > 22 * 1024 * 1024) throw new TypeError("Invalid or oversized artifact request.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const data = request.encoding === "base64" ? Buffer.from(request.data, "base64") : request.data;
  const record = await currentExecutionArtifactStore().put({ ...request, projectId, data });
  await appendRuntimeLog("Stored " + record.kind + " execution artifact " + record.id + " for project " + projectId + ".");
  return record;
});
ipcMain.handle("axiom:artifact-read", async (event, artifactId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  const result = await currentExecutionArtifactStore().read(projectId, artifactId);
  return { record: result.record, data: result.data.toString("base64"), encoding: "base64" };
});
ipcMain.handle("axiom:artifact-remove", async (event, artifactId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const projectId = require("node:crypto").createHash("sha256").update(path.resolve(selectedWorkspace)).digest("hex").slice(0, 40);
  return currentExecutionArtifactStore().remove(projectId, artifactId);
});

ipcMain.handle("axiom:project-context-save", async (event, context) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectStore().saveContext(context);
});

ipcMain.handle("axiom:change-feed-add", async (event, change) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return currentProjectStore().addChange(change);
});

ipcMain.handle("axiom:choose-project", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const nextWorkspace = await chooseWorkspace();
  if (!nextWorkspace || path.resolve(nextWorkspace) === path.resolve(selectedWorkspace || "")) return null;
  const resolvedWorkspace = path.resolve(nextWorkspace);
  isQuitting = true;
  await appendRuntimeLog(`Switching project from ${selectedWorkspace} to ${resolvedWorkspace}.`);
  await stopRuntime();
  app.relaunch({ args: [...process.argv.slice(1).filter(arg => !arg.startsWith("--axiom-workspace=")), `--axiom-workspace=${resolvedWorkspace}`] });
  app.quit();
  return resolvedWorkspace;
});

ipcMain.handle("axiom:create-project", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Create an Axiom project",
    buttonLabel: "Create Project",
    defaultPath: path.join(app.getPath("documents"), "Axiom Project"),
  });
  if (result.canceled || !result.filePath) return null;
  const resolvedWorkspace = path.resolve(result.filePath);
  if (resolvedWorkspace === path.parse(resolvedWorkspace).root) {
    throw new Error("A project cannot be created at a filesystem root.");
  }
  try {
    await fs.promises.mkdir(resolvedWorkspace);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error("That folder already exists. Choose a new folder name so Axiom does not overwrite an existing project.");
    }
    throw error;
  }
  isQuitting = true;
  await appendRuntimeLog("Creating project at " + resolvedWorkspace + ".");
  await stopRuntime();
  app.relaunch({ args: [...process.argv.slice(1).filter(arg => !arg.startsWith("--axiom-workspace=")), `--axiom-workspace=${resolvedWorkspace}`] });
  app.quit();
  return resolvedWorkspace;
});

ipcMain.on("axiom:webview-message", async (event, message) => {
  if (!trustedRenderer(event)) return;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "create-agent-worktree") {
    try {
      validateWorkspace(message.workspaceRoot);
      if (!Array.isArray(message.targetFiles) || message.targetFiles.length === 0) throw new Error("Worker tasks must declare explicit target-file ownership before a worktree can be created.");
      ownershipForWorkspace(message.workspaceRoot).claim(message.taskId, message.targetFiles);
      const worktreePath = await createDetachedWorktree({
        workspaceRoot: message.workspaceRoot,
        userDataPath: app.getPath("userData"),
        taskId: message.taskId,
      });
      sendHostMessage(event, { type: "agent-worktree-result", requestId: message.requestId, ok: true, path: worktreePath });
    } catch (error) {
      if (typeof message.taskId === "string" && message.workspaceRoot) ownershipForWorkspace(message.workspaceRoot).release(message.taskId);
      sendHostMessage(event, { type: "agent-worktree-result", requestId: message.requestId, ok: false, error: error.message });
    }
  } else if (message.type === "inspect-agent-worktree") {
    await inspectWorktree(event, message);
  } else if (message.type === "run-agent-quality-gate") {
    await runQualityGate(event, message);
  } else if (message.type === "apply-agent-worktree-changes") {
    await applyWorktreeChanges(event, message);
  } else if (message.type === "open-external-url" && typeof message.url === "string") {
    try {
      const url = new URL(message.url);
      if (url.protocol === "https:" && url.hostname === "opencode.ai" && url.pathname === "/docs/providers/") {
        await shell.openExternal(url.toString());
      } else {
        throw new Error("Blocked an external URL that is not on the approved provider documentation page.");
      }
    } catch (error) {
      await appendRuntimeLog(`Blocked or failed external navigation: ${error.message}`);
    }
  } else if (message.type === "open-file" && typeof message.url === "string") {
    const filePath = message.url.startsWith("file://") ? new URL(message.url).pathname : message.url;
    if (path.isAbsolute(filePath) && insidePath(selectedWorkspace, filePath)) {
      await shell.openPath(filePath);
    }
  }
});

async function stopRuntime() {
  stoppingRuntime = true;
  if (openCodeTelemetryBridge) await openCodeTelemetryBridge.stop();
  await stopRuntimeNetworkProxy();
  const child = runtimeProcess;
  runtimeProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    stoppingRuntime = false;
    return;
  }

  await appendRuntimeLog("Requesting local runtime shutdown.");
  if (process.platform === "win32" && child.pid) {
    // Ask the process tree to close before falling back to a forced termination.
    try {
      await execFileAsync("taskkill", ["/pid", String(child.pid), "/t"], { timeout: 5000, windowsHide: true });
    } catch {
      // A process may already have exited; verify below before escalating.
    }
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }

  const exited = await Promise.race([
    new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(true);
      else child.once("exit", () => resolve(true));
    }),
    new Promise(resolve => setTimeout(() => resolve(false), 3000))
  ]);

  if (!exited && child.exitCode === null && child.signalCode === null) {
    await appendRuntimeLog("Runtime did not stop within 3 seconds; forcing process termination.");
    if (process.platform === "win32" && child.pid) {
      try {
        await execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { timeout: 10000, windowsHide: true });
      } catch {
        try { child.kill(); } catch {}
      }
    } else {
      try { child.kill("SIGKILL"); } catch {}
    }
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
  }
  await appendRuntimeLog("Runtime shutdown sequence completed.");
  stoppingRuntime = false;
}

app.whenReady().then(async () => {
  await restoreRemoteWorkspaceJobs();
  omniRouteManager = createOmniRouteManager({ userDataPath: app.getPath("userData"), safeStorage });
  mcpManager = createMcpManager({ userDataPath: app.getPath("userData"), safeStorage });
  const { Menu } = require("electron");
  const menu = Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Switch Project…", accelerator: "Ctrl+O", click: async () => {
        const nextWorkspace = await chooseWorkspace();
        if (!nextWorkspace || path.resolve(nextWorkspace) === path.resolve(selectedWorkspace || "")) return;
        isQuitting = true;
        await appendRuntimeLog(`Switching project from ${selectedWorkspace} to ${path.resolve(nextWorkspace)}.`);
        await stopRuntime();
        app.relaunch({ args: [...process.argv.slice(1).filter(arg => !arg.startsWith("--axiom-workspace=")), `--axiom-workspace=${path.resolve(nextWorkspace)}`] });
        app.quit();
      } },
      { type: "separator" },
      { role: "quit" }
    ] },
    { label: "Help", submenu: [
      { label: "Open Axiom Runtime Log", click: () => { void shell.openPath(path.join(app.getPath("userData"), "logs", "runtime.log")); } },
      { label: "About Axiom", click: () => dialog.showMessageBox({ title: "About Axiom", message: `Axiom ${app.getVersion()}`, detail: "Standalone AI-first project-building desktop app." }) }
    ] }
  ]);
  Menu.setApplicationMenu(menu);
  return createWindow();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) createWindow();
});
app.on("before-quit", event => {
  isQuitting = true;
  if (shutdownStarted) return;
  shutdownStarted = true;
  if ((runtimeProcess && runtimeProcess.exitCode === null) || (terminalRunner && terminalRunner.activeCount() > 0) || (omniRouteManager && omniRouteManager.ownsProcess())) {
    event.preventDefault();
    void Promise.allSettled([terminalRunner ? terminalRunner.stopAll() : Promise.resolve(), stopRuntime(), omniRouteManager ? omniRouteManager.stop() : Promise.resolve()]).finally(() => app.quit());
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
