import * as vscode from "vscode";
import { OpenCodeService } from "./OpenCodeService";
import { OpenCodeViewProvider } from "./OpenCodeViewProvider";
import type { HostMessage } from "./shared/messages";
import { openAxiomRuntimeDashboard } from "./axiom/runtimeDashboard";
import { OmniRouteClient } from "./axiom/omniRouteClient";
import { AxiomErrorHealing } from "./axiom/errorHealing";
import { AxiomRuntimeService } from "./axiom/runtimeService";

let logger: vscode.LogOutputChannel;

export function getLogger(): vscode.LogOutputChannel {
  return logger;
}

export async function activate(context: vscode.ExtensionContext) {
  // Create log channel - VSCode manages file location and timestamps automatically
  logger = vscode.window.createOutputChannel("OpenCode", { log: true });
  context.subscriptions.push(logger);

  logger.info("OpenCode extension activated", {
    timestamp: new Date().toISOString(),
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    extensionPath: context.extensionPath,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("axiom.checkOmniRoute", async () => {
      const result = await new OmniRouteClient().healthCheck();
      if (result.ok) {
        vscode.window.showInformationMessage(`Axiom: OmniRoute responded in ${result.latencyMs ?? "?"} ms at ${result.url}`);
      } else {
        vscode.window.showErrorMessage(`Axiom: OmniRoute is unavailable at ${result.url}: ${result.error ?? "unknown error"}`);
      }
    }),
    vscode.commands.registerCommand("axiom.analyzeDiagnostics", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Axiom: Open a file to analyze its diagnostics.");
        return;
      }
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(item => item.severity === vscode.DiagnosticSeverity.Error);
      if (!diagnostics.length) {
        vscode.window.showInformationMessage("Axiom: No compiler or language-service errors found in the active file.");
        return;
      }
      const healing = new AxiomErrorHealing();
      let analyzed = 0;
      for (const diagnostic of diagnostics.slice(0, 5)) {
        try {
          await healing.suggestRepair(editor.document, diagnostic);
          analyzed++;
        } catch (error) {
          logger.warn("Axiom diagnostic analysis failed", error);
        }
      }
      vscode.window.showInformationMessage(`Axiom: Analyzed ${analyzed} of ${Math.min(diagnostics.length, 5)} diagnostics. Suggestions require review; no files were modified.`);
    }),
  );

  // Create OpenCode service
  const openCodeService = new OpenCodeService();

  // Initialize OpenCode with workspace root
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  try {
    await openCodeService.initialize(workspaceRoot);
    logger.info("OpenCode service initialized successfully");
  } catch (error) {
    logger.error("Failed to initialize OpenCode service", error);
  }

  const axiomRuntime = new AxiomRuntimeService(openCodeService);
  context.subscriptions.push(axiomRuntime);
  context.subscriptions.push(
    vscode.commands.registerCommand("axiom.runGoal", async () => {
      const goal = await vscode.window.showInputBox({ title: "Axiom — plan and execute", prompt: "Describe the outcome to plan and execute through OpenCode worker sessions.", ignoreFocusOut: true });
      if (!goal?.trim()) return;
      try { await axiomRuntime.runGoal(goal.trim()); }
      catch (error) { vscode.window.showErrorMessage(`Axiom run failed: ${error instanceof Error ? error.message : String(error)}`); }
    }),
    vscode.commands.registerCommand("axiom.cancelRun", () => axiomRuntime.cancelRun()),
    vscode.commands.registerCommand("axiom.openRuntimeDashboard", () => { openAxiomRuntimeDashboard(context, axiomRuntime); }),
  );

  const provider = new OpenCodeViewProvider(
    context.extensionUri,
    openCodeService,
    context.globalState
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OpenCodeViewProvider.viewType,
      provider
    )
  );

  const addSelectionDisposable = vscode.commands.registerCommand(
    "opencode.addSelectionToPrompt",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("OpenCode: No active editor selection.");
        return;
      }

      const document = editor.document;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const filePath = workspaceFolder
        ? vscode.workspace.asRelativePath(document.uri)
        : document.uri.fsPath;
      const fileUrl = document.uri.toString();

      const selection = editor.selection;
      const message: HostMessage = {
        type: "editor-selection",
        filePath,
        fileUrl,
        selection: selection.isEmpty
          ? undefined
          : {
              startLine: selection.start.line + 1,
              endLine: selection.end.line + 1,
            },
      };

      await vscode.commands.executeCommand("workbench.view.extension.opencode");
      provider.sendHostMessage(message);
    }
  );

  context.subscriptions.push(addSelectionDisposable);

  // Cleanup on deactivation
  context.subscriptions.push(openCodeService);

  logger.info("OpenCode webview provider registered");
}

export function deactivate() {
  logger?.info("OpenCode extension deactivated");
}
