import * as vscode from "vscode";
import { AxiomOrchestrator, type AxiomSubTask, type TaskResult } from "./orchestrator";
import { OpenCodeService } from "../OpenCodeService";

export type RuntimeEvent =
  | { kind: "worker"; at: number; taskId: string; scope: string; state: string; sessionId?: string; detail?: string }
  | { kind: "diagnostic"; at: number; file: string; severity: string; message: string; line: number; code?: string }
  | { kind: "run"; at: number; goal: string; state: string; detail?: string };

export class AxiomRuntimeService implements vscode.Disposable {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly recentEvents: RuntimeEvent[] = [];
  private activeRun?: AbortController;
  private readonly diagnosticSubscription: vscode.Disposable;

  constructor(private readonly openCode: OpenCodeService) {
    this.diagnosticSubscription = vscode.languages.onDidChangeDiagnostics(event => {
      for (const uri of event.uris) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        for (const diagnostic of diagnostics) {
          this.publish({
            kind: "diagnostic",
            at: Date.now(),
            file: vscode.workspace.asRelativePath(uri),
            severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error"
              : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? "warning"
              : diagnostic.severity === vscode.DiagnosticSeverity.Information ? "info" : "hint",
            message: diagnostic.message.slice(0, 1000),
            line: diagnostic.range.start.line + 1,
            code: diagnostic.code === undefined ? undefined : String(typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code),
          });
        }
      }
    });
  }

  subscribe(listener: (event: RuntimeEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    for (const event of this.recentEvents) listener(event);
    return { dispose: () => this.listeners.delete(listener) };
  }

  isOpenCodeReady(): boolean { return this.openCode.isReady(); }

  getEvents(): RuntimeEvent[] {
    return [...this.recentEvents];
  }

  async runGoal(goal: string): Promise<void> {
    if (this.activeRun) throw new Error("An Axiom plan is already running.");
    if (!this.openCode.isReady()) throw new Error("OpenCode is not ready. Ensure the OpenCode server started successfully.");
    const controller = new AbortController();
    this.activeRun = controller;
    this.publish({ kind: "run", at: Date.now(), goal, state: "planning" });
    try {
      const workspaceRoot = this.openCode.getWorkspaceRoot();
      const workspaceContext = {
        workspaceRoot,
        openFiles: vscode.workspace.textDocuments.slice(0, 12).map(doc => ({
          path: vscode.workspace.asRelativePath(doc.uri),
          language: doc.languageId,
          lineCount: doc.lineCount,
        })),
        diagnostics: vscode.languages.getDiagnostics().slice(0, 80).map(([uri, diagnostics]) => ({
          file: vscode.workspace.asRelativePath(uri),
          diagnostics: diagnostics.slice(0, 8).map(d => ({ message: d.message, line: d.range.start.line + 1, severity: d.severity })),
        })),
      };
      const orchestrator = new AxiomOrchestrator(async (task: AxiomSubTask, signal: AbortSignal) => {
        this.publish({ kind: "worker", at: Date.now(), taskId: task.id, scope: task.scope, state: "starting" });
        const prompt = [
          "You are an Axiom worker operating in a real OpenCode session.",
          "Carry out the task in the current workspace using available tools. Inspect before editing, keep changes scoped, and report files changed and validation performed.",
          "Do not claim a change or test that you did not actually perform.",
          "",
          JSON.stringify({ id: task.id, scope: task.scope, description: task.description, targetFiles: task.targetFiles, dependsOn: task.dependsOn }, null, 2),
        ].join("\n");
        try {
          const result = await this.openCode.executeWorkerTask(`Axiom worker: ${task.id}`, prompt, signal);
          this.publish({ kind: "worker", at: Date.now(), taskId: task.id, scope: task.scope, state: "completed", sessionId: result.sessionId, detail: result.output.slice(0, 1800) });
          return `OpenCode session: ${result.sessionId}\n\n${result.output}`;
        } catch (error) {
          this.publish({ kind: "worker", at: Date.now(), taskId: task.id, scope: task.scope, state: "failed", detail: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
      const tasks = await orchestrator.plan(goal, workspaceContext, controller.signal);
      this.publish({ kind: "run", at: Date.now(), goal, state: "executing", detail: `${tasks.length} planned tasks` });
      const results: TaskResult[] = await orchestrator.run(tasks, controller.signal, result => {
        this.publish({
          kind: "worker", at: Date.now(), taskId: result.task.id, scope: result.task.scope,
          state: result.state, detail: result.error ?? result.output?.slice(0, 800),
        });
      });
      const failed = results.filter(result => result.state === "failed" || result.state === "blocked").length;
      this.publish({ kind: "run", at: Date.now(), goal, state: failed ? "finished-with-errors" : "completed", detail: `${results.length - failed}/${results.length} tasks completed` });
    } catch (error) {
      this.publish({ kind: "run", at: Date.now(), goal, state: controller.signal.aborted ? "cancelled" : "failed", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeRun = undefined;
    }
  }

  cancelRun(): void {
    this.activeRun?.abort();
  }

  private publish(event: RuntimeEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 250) this.recentEvents.splice(0, this.recentEvents.length - 250);
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.diagnosticSubscription.dispose();
    this.cancelRun();
    this.listeners.clear();
  }
}
