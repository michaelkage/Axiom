import * as vscode from "vscode";

export type ErrorHealingLevel = "off" | "notify" | "silent";

export interface AxiomRuntimeConfig {
  gatewayUrl: string;
  plannerModel: string;
  workerModel: string;
  enableSubAgents: boolean;
  maxConcurrentWorkers: number;
  requestTimeoutMs: number;
  errorHealingLevel: ErrorHealingLevel;
}

const DEFAULTS: AxiomRuntimeConfig = {
  gatewayUrl: "http://127.0.0.1:20128/v1",
  plannerModel: "omni-planner-combo",
  workerModel: "omni-worker-combo",
  enableSubAgents: true,
  maxConcurrentWorkers: 3,
  requestTimeoutMs: 30_000,
  errorHealingLevel: "notify",
};

export function getAxiomConfig(): AxiomRuntimeConfig {
  const config = vscode.workspace.getConfiguration("axiom");
  const rawUrl = config.get<string>("gatewayUrl", DEFAULTS.gatewayUrl).trim();
  let gatewayUrl = DEFAULTS.gatewayUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      gatewayUrl = parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // Keep the safe, known-local default for malformed configuration.
  }

  const maxConcurrentWorkers = config.get<number>(
    "maxConcurrentWorkers",
    DEFAULTS.maxConcurrentWorkers,
  );

  return {
    gatewayUrl,
    plannerModel: config.get<string>("plannerModel", DEFAULTS.plannerModel),
    workerModel: config.get<string>("workerModel", DEFAULTS.workerModel),
    enableSubAgents: config.get<boolean>("enableSubAgents", DEFAULTS.enableSubAgents),
    maxConcurrentWorkers: Number.isFinite(maxConcurrentWorkers)
      ? Math.min(8, Math.max(1, Math.floor(maxConcurrentWorkers)))
      : DEFAULTS.maxConcurrentWorkers,
    requestTimeoutMs: Math.min(
      120_000,
      Math.max(1_000, config.get<number>("requestTimeoutMs", DEFAULTS.requestTimeoutMs)),
    ),
    errorHealingLevel: config.get<ErrorHealingLevel>(
      "errorHealingLevel",
      DEFAULTS.errorHealingLevel,
    ),
  };
}
