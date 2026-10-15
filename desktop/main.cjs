const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
let selectedWorkspace;
let runtimeProcess;
let mainWindow;
let isQuitting = false;
let shutdownStarted = false;

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
    await fs.promises.appendFile(logPath, `[${new Date().toISOString()}] ${text}\\n`, "utf8");
  } catch { /* Diagnostics must never prevent startup or shutdown. */ }
}

function runtimeExecutable() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules")
    : path.join(__dirname, "node_modules");
  const candidates = process.platform === "win32"
    ? [path.join(base, ".bin", "opencode.cmd"), path.join(base, ".bin", "opencode.exe")]
    : [path.join(base, ".bin", "opencode")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const globalLookup = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["opencode"],
    { encoding: "utf8", windowsHide: true }
  );
  if (globalLookup.status === 0 && globalLookup.stdout.trim()) {
    return globalLookup.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  }
  throw new Error("Axiom's bundled OpenCode runtime could not be found. Reinstall Axiom using the latest Windows installer.");
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
  const executable = runtimeExecutable();
  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
  runtimeProcess = spawn(executable, args, {
    cwd: workspace,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  let recentOutput = "";
  const collect = chunk => {
    recentOutput = (recentOutput + chunk.toString()).slice(-6000);
  };
  runtimeProcess.stdout?.on("data", collect);
  runtimeProcess.stderr?.on("data", collect);
  runtimeProcess.on("error", error => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox("Axiom runtime error", error.message);
    }
  });

  const url = "http://127.0.0.1:" + port;
  try {
    await waitForRuntime(url, runtimeProcess);
  } catch (error) {
    runtimeProcess.kill();
    const detail = recentOutput.trim();
    throw new Error(error.message + (detail ? "\n\nRuntime output:\n" + detail : ""));
  }
  return url;
}

async function createWindow() {
  const workspace = await chooseWorkspace();
  if (!workspace) {
    app.quit();
    return;
  }

  selectedWorkspace = path.resolve(workspace);
  let serverUrl;
  try {
    serverUrl = await startRuntime(workspace);
  } catch (error) {
    dialog.showErrorBox("Axiom could not start", error.message);
    app.quit();
    return;
  }

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

  mainWindow.once("ready-to-show", () => mainWindow.show());\n  mainWindow.on("closed", () => { mainWindow = null; });
  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, "out", "src", "webview", "standalone.html")
    : path.join(__dirname, "..", "out", "src", "webview", "standalone.html");
  await mainWindow.loadFile(htmlPath, {
    query: {
      serverUrl,
      workspaceRoot: workspace
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
  const result = await run("git", ["status", "--short", "--untracked-files=all"], worktree);
  if (result.exitCode !== 0) throw new Error(result.output || "Git status failed.");
  return result.output.split(/\r?\n/).filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim() || "??",
    path: line.slice(3).trim()
  }));
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
      const full = path.resolve(message.worktreePath, file.path);
      if (!insidePath(message.worktreePath, full)) throw new Error("A changed file path escaped the task worktree.");
      try {
        const stat = await fs.promises.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const content = (await fs.promises.readFile(full, "utf8")).slice(0, 30000);
        patch += "\n\n--- NEW FILE: " + file.path + " ---\n" + content;
      } catch {}
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
    const paths = Array.isArray(message.changedPaths) ? message.changedPaths : [];
    await addCheck("Git whitespace and conflict-marker check", "git", ["diff", "--check", "HEAD", "--"], message.worktreePath, 30000);

    const untracked = (await changedFiles(message.worktreePath)).filter(file => file.status === "??");
    let untrackedIssues = [];
    for (const file of untracked) {
      const full = path.resolve(message.worktreePath, file.path);
      if (!insidePath(message.worktreePath, full)) continue;
      try {
        const stat = await fs.promises.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const text = await fs.promises.readFile(full, "utf8");
        const lines = text.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/[ \t]+$/.test(line)) untrackedIssues.push(file.path + ":" + (index + 1) + ": trailing whitespace");
          if (/^(<<<<<<< |=======|>>>>>>> )/.test(line)) untrackedIssues.push(file.path + ":" + (index + 1) + ": possible unresolved conflict marker");
        });
      } catch {}
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
    sendHostMessage(event, { type: "agent-quality-gate-result", taskId: message.taskId, status, checks, ranProjectCheck });
  } catch (error) {
    sendHostMessage(event, { type: "agent-quality-gate-result", taskId: message.taskId, status: "Blocked", checks, error: error.message });
  }
}

async function applyWorktreeChanges(event, message) {
  const appliedPaths = [];
  try {
    validateWorkspace(message.workspaceRoot);
    const root = await gitRoot(message.workspaceRoot);
    if (await gitRoot(message.worktreePath) !== root) throw new Error("Task worktree belongs to a different Git repository.");
    const requested = Array.isArray(message.paths) ? [...new Set(message.paths)] : [];
    if (!requested.length) throw new Error("Select at least one file to integrate.");
    for (const relative of requested) {
      const source = path.resolve(message.worktreePath, relative);
      const destination = path.resolve(root, relative);
      if (!insidePath(message.worktreePath, source) || !insidePath(root, destination)) throw new Error("A selected path escaped the project repository.");
      const dirty = await run("git", ["status", "--porcelain", "--", relative], root);
      if (dirty.output.trim()) throw new Error("Integration blocked for " + relative + ": the destination has local changes.");
      const tracked = await run("git", ["ls-files", "--error-unmatch", "--", relative], root);
      if (tracked.exitCode !== 0 && fs.existsSync(destination)) {
        throw new Error("Integration blocked for " + relative + ": an existing untracked or ignored destination file would be overwritten.");
      }
      try {
        const sourceStat = await fs.promises.lstat(source);
        if (sourceStat.isSymbolicLink()) throw new Error("Integration blocked for " + relative + ": symbolic links are not copied.");
        if (!sourceStat.isFile()) throw new Error("Integration blocked for " + relative + ": only regular files can be integrated.");
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(source, destination);
      } catch (error) {
        if (error.code === "ENOENT") {
          try { await fs.promises.unlink(destination); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
        } else {
          throw error;
        }
      }
      appliedPaths.push(relative);
    }
    sendHostMessage(event, { type: "agent-worktree-apply-result", taskId: message.taskId, ok: true, appliedPaths });
  } catch (error) {
    sendHostMessage(event, { type: "agent-worktree-apply-result", taskId: message.taskId, ok: false, error: error.message, appliedPaths });
  }
}

ipcMain.on("axiom:webview-message", async (event, message) => {
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
  } else if (message.type === "open-file" && typeof message.url === "string") {
    const filePath = message.url.startsWith("file://") ? new URL(message.url).pathname : message.url;
    if (path.isAbsolute(filePath) && insidePath(selectedWorkspace, filePath)) {
      await shell.openPath(filePath);
    }
  }
});

app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", () => {
  if (runtimeProcess && runtimeProcess.exitCode === null) runtimeProcess.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
