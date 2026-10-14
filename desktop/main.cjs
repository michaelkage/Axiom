const { app, BrowserWindow, dialog } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

let runtimeProcess;
let mainWindow;

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, "out", "standalone.html")
    : path.join(__dirname, "..", "out", "standalone.html");
  await mainWindow.loadFile(htmlPath, {
    query: {
      serverUrl,
      workspaceRoot: workspace
    }
  });
}

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
