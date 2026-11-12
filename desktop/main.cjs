const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createProjectStore } = require("./project-store.cjs");
const { createSecureStorage } = require("./secure-storage.cjs");
const { redactSecrets } = require("./security-redaction.cjs");
const { listDirectory, readProjectFile, writeProjectFile } = require("./filesystem.cjs");
const { createTerminalRunner } = require("./terminal.cjs");
const { createOmniRouteManager } = require("./omniroute.cjs");
const { classifyWorkspaceDrift } = require("./workspace-drift.cjs");
const { normalizeWorkspaceRelativePath, resolveSafeWorkspaceFile, parseGitStatusPorcelainZ, readRegularFileNoFollow, applyStagedWorkspaceFiles, withWorkspaceIntegrationLock } = require("./worktree-integration.cjs");
const { createWorkerStateStore } = require("./worker-state.cjs");
const { createMcpManager } = require("./mcp-manager.cjs");
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
let secureCredentialStore;
function currentSecureCredentialStore() {
  if (!secureCredentialStore) secureCredentialStore = createSecureStorage({ userDataPath: app.getPath("userData"), safeStorage });
  return secureCredentialStore;
}
let activeRuntimeUrl = null;
let mainWindow;
let isQuitting = false;
let shutdownStarted = false;
const remoteWorkspaceJobs = new Map();
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

function runtimeConfigurationEnvironment() {
  const merged = {};
  for (const manager of [omniRouteManager, mcpManager]) {
    const environment = manager ? manager.openCodeEnvironment({ workspaceRoot: selectedWorkspace }) : {};
    if (environment.OPENCODE_CONFIG_CONTENT) {
      try { Object.assign(merged, JSON.parse(environment.OPENCODE_CONFIG_CONTENT)); }
      catch { throw new Error("Axiom generated invalid local runtime configuration; startup was blocked."); }
    }
  }
  return Object.keys(merged).length ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(merged) } : {};
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
  runtimeProcess = spawn(executable, args, {
    cwd: workspace,
    windowsHide: true,
    // Native .exe paths must bypass cmd.exe. In particular, shell:true splits
    // "C:\\Program Files\\..." and makes Windows try to execute "C:\\Program".
    shell: process.platform === "win32" && /\\.(cmd|bat)$/i.test(executable),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...runtimeEnvironment, ...runtimeConfigurationEnvironment() }
  });

  let recentOutput = "";
  const collect = chunk => {
    recentOutput = (recentOutput + chunk.toString()).slice(-6000);
  };
  runtimeProcess.stdout?.on("data", chunk => { collect(chunk); void appendRuntimeLog(chunk.toString().trimEnd()); });
  runtimeProcess.stderr?.on("data", chunk => { collect(chunk); void appendRuntimeLog(chunk.toString().trimEnd()); });
  runtimeProcess.on("error", error => {
    void appendRuntimeLog(`Runtime process error: ${error.stack || error.message}`);
    if (mainWindow && !mainWindow.isDestroyed() && !isQuitting) {
      void dialog.showMessageBox(mainWindow, { type: "error", title: "Axiom runtime error", message: "Axiom could not launch its local AI runtime.", detail: `${error.message}\n\nRuntime log: ${path.join(app.getPath("userData"), "logs", "runtime.log")}\n\nRestart Axiom after reviewing the log.`, buttons: ["OK"] });
    }
  });
  runtimeProcess.on("exit", (code, signal) => {
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
  mainWindow.on("closed", () => { mainWindow = null; });
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

async function runQualityGate(event, message) {
  const checks = [];
  const addCheck = async (name, command, args, cwd, timeout) => {
    const result = await run(command, args, cwd, timeout);
    checks.push({ name, state: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, output: result.output || "Command completed without output." });
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
    let untrackedIssues = [];
    for (const file of untracked) {
      const full = path.resolve(message.worktreePath, file.path);
      if (!insidePath(message.worktreePath, full)) continue;
      try {
        const stat = await fs.promises.lstat(full);
        if (stat.isSymbolicLink()) {
          untrackedIssues.push(file.path + ": symbolic links are not allowed in worker changes");
          continue;
        }
        if (!stat.isFile()) {
          untrackedIssues.push(file.path + ": only regular files can be integrated");
          continue;
        }
        if (stat.size > 5 * 1024 * 1024) {
          untrackedIssues.push(file.path + ": exceeds the 5 MiB untracked-file quality inspection limit");
          continue;
        }
        const text = await fs.promises.readFile(full, "utf8");
        const lines = text.split(/\r?\n/);
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
    const testPaths = paths.filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
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

    const failed = checks.some(check => check.state !== "passed");
    const ranProjectCheck = checks.some(check => check.name === "Targeted unit tests" || check.name === "Project build");
    const status = failed ? "Needs fixes" : "Ready to review";
    const historyStatus = failed ? "failed" : ranProjectCheck ? "verified" : "review";
    await currentProjectStore().addChange({
      title: "Automated verification run",
      summary: checks.length + " checks recorded; " + checks.filter(check => check.state === "passed").length + " passed, " + checks.filter(check => check.state !== "passed").length + " failed. " + (ranProjectCheck ? "A project-level test or build command ran." : "No project-level test or build command was available for this change."),
      status: historyStatus,
      checks: checks.map(check => ({ name: check.name, state: check.state === "passed" ? "passed" : "failed", details: "Exit code: " + check.exitCode + ". Full output is available in the verification panel." })),
      files: Array.isArray(message.changedPaths) ? message.changedPaths : []
    });
    sendHostMessage(event, { type: "agent-quality-gate-result", taskId: message.taskId, status, checks, ranProjectCheck });
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
    sendHostMessage(event, { type: "agent-quality-gate-result", taskId: message.taskId, status: "Blocked", checks, error: error.message });
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
        const destinationBackup = destinationStat ? await readRegularFileNoFollow(destination) : null;
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

function currentProjectStore() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return createProjectStore(app.getPath("userData"), selectedWorkspace);
}
function currentWorkerStateStore() {
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return createWorkerStateStore(app.getPath("userData"), selectedWorkspace);
}

ipcMain.handle("axiom:secure-storage-get", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.namespace !== "string" || typeof request.key !== "string") throw new Error("Invalid secure storage request.");
  return currentSecureCredentialStore().get(request.namespace, request.key);
});

ipcMain.handle("axiom:secure-storage-set", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.namespace !== "string" || typeof request.key !== "string" || typeof request.value !== "string") throw new Error("Invalid secure storage request.");
  return currentSecureCredentialStore().set(request.namespace, request.key, request.value);
});

ipcMain.handle("axiom:secure-storage-remove", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.namespace !== "string" || typeof request.key !== "string") throw new Error("Invalid secure storage request.");
  return currentSecureCredentialStore().remove(request.namespace, request.key);
});

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

ipcMain.handle("axiom:mcp-save-secret", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string" || typeof request.secret !== "string") throw new Error("Invalid MCP credential request.");
  const result = mcpManager.saveSecret(request.id, request.secret);
  void appendRuntimeLog("Saved secure MCP credential for " + request.id + "; restart required to load the integration.");
  return result;
});

ipcMain.handle("axiom:mcp-enable", (event, request) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!request || typeof request.id !== "string" || typeof request.enabled !== "boolean") throw new Error("Invalid MCP enable request.");
  const result = mcpManager.setEnabled(request.id, request.enabled);
  void appendRuntimeLog("MCP integration " + request.id + " set enabled=" + request.enabled + "; restart required.");
  return result;
});

ipcMain.handle("axiom:mcp-remove", (event, id) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  const result = mcpManager.remove(id);
  void appendRuntimeLog("Removed MCP integration configuration for " + id + "; restart required.");
  return result;
});

ipcMain.handle("axiom:omniroute-status", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return omniRouteManager.status();
});

ipcMain.handle("axiom:omniroute-check", async (event, settings) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return omniRouteManager.checkConnection(settings);
});

ipcMain.handle("axiom:omniroute-save", async (event, settings) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return omniRouteManager.save(settings);
});

ipcMain.handle("axiom:omniroute-install", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  return omniRouteManager.install();
});

ipcMain.handle("axiom:omniroute-start", async event => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
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
  await shell.openExternal(url.toString());
  return true;
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
  const job = request && remoteWorkspaceJobs.get(request.id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
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
  const job = request && remoteWorkspaceJobs.get(request.id);
  if (!job) throw new Error("Remote workspace job not found in this session.");
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
  if (!request || typeof request.requestId !== "string" || typeof request.command !== "string") {
    throw new Error("A terminal request needs a request ID and command.");
  }
  return terminalRunner.run({
    requestId: request.requestId,
    command: request.command,
    cwd: request.cwd,
    onOutput: chunk => {
      if (!event.sender.isDestroyed()) event.sender.send("axiom:terminal-output", {
        requestId: request.requestId,
        stream: chunk.stream,
        text: chunk.text
      });
    }
  });
});

ipcMain.handle("axiom:terminal-cancel", async (event, requestId) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!terminalRunner || typeof requestId !== "string") return false;
  return terminalRunner.cancel(requestId);
});

ipcMain.handle("axiom:fs-list", async (event, relativePath = "") => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return listDirectory(selectedWorkspace, relativePath);
});

ipcMain.handle("axiom:fs-read", async (event, relativePath) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
  return readProjectFile(selectedWorkspace, relativePath);
});

ipcMain.handle("axiom:fs-write", async (event, relativePath, content) => {
  if (!trustedRenderer(event)) throw new Error("Untrusted renderer.");
  if (!selectedWorkspace) throw new Error("No project is currently open.");
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
      const root = await gitRoot(message.workspaceRoot);
      const safeId = String(message.taskId || "task").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
      const worktreeBase = path.join(app.getPath("userData"), "worktrees", path.basename(root));
      await fs.promises.mkdir(worktreeBase, { recursive: true });
      const worktreePath = path.join(worktreeBase, safeId + "-" + Date.now());
      const result = await run("git", ["-C", root, "worktree", "add", "--detach", worktreePath, "HEAD"], root, 60000);
      if (result.exitCode !== 0) throw new Error(result.output || "Git could not create a task worktree.");
      sendHostMessage(event, { type: "agent-worktree-result", requestId: message.requestId, ok: true, path: worktreePath });
    } catch (error) {
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
