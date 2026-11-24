export type ModelCapability = "text" | "vision" | "tools" | "json" | "reasoning" | "audio" | "embedding";
export type ModelProviderKind = "openai-compatible" | "local" | "omniroute" | "native";
export interface ModelDescriptor {
  id: string;
  providerId: string;
  providerKind: ModelProviderKind;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  available: boolean;
  installed: boolean;
  source: "live-discovery" | "provider-catalog" | "local-installation";
  lastSeenAt: number;
}
export interface ModelProvider {
  id: string;
  kind: ModelProviderKind;
  label: string;
  endpoint?: string;
  configured: boolean;
  connected: boolean;
  lastCheckedAt?: number;
  error?: string;
}
export interface ModelRequirement {
  capabilities?: ModelCapability[];
  minimumContextWindow?: number;
  providerIds?: string[];
  preferLocal?: boolean;
}
export interface ModelSelection {
  model: ModelDescriptor;
  score: number;
  reasons: string[];
}
const CAPABILITIES = new Set<ModelCapability>(["text", "vision", "tools", "json", "reasoning", "audio", "embedding"]);
const MAX_MODELS = 2_000;

function safeId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw new TypeError(name + " must be a valid stable identifier.");
  return value;
}
export function normalizeModelDescriptor(input: ModelDescriptor): ModelDescriptor {
  const id = safeId(input.id, "Model ID");
  const providerId = safeId(input.providerId, "Provider ID");
  if (!["openai-compatible", "local", "omniroute", "native"].includes(input.providerKind)) throw new TypeError("Unknown model provider kind.");
  if (!Array.isArray(input.capabilities) || input.capabilities.some(capability => !CAPABILITIES.has(capability))) throw new TypeError("Model capabilities contain unsupported values.");
  if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 200) throw new TypeError("Model display name is invalid.");
  for (const [name, value] of [["contextWindow", input.contextWindow], ["maxOutputTokens", input.maxOutputTokens]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 10_000_000)) throw new RangeError(name + " must be a positive bounded integer.");
  }
  if (!Number.isFinite(input.lastSeenAt) || input.lastSeenAt < 0) throw new TypeError("Model discovery timestamp is invalid.");
  return { ...input, id, providerId, displayName: input.displayName.trim(), capabilities: [...new Set(input.capabilities)] };
}

/** Merge live discovery snapshots without inventing defaults or retaining phantom models. */
export function mergeDiscoveredModels(previous: readonly ModelDescriptor[], discovered: readonly ModelDescriptor[]): ModelDescriptor[] {
  if (discovered.length > MAX_MODELS) throw new RangeError("Model discovery returned too many models.");
  const next = new Map<string, ModelDescriptor>();
  for (const raw of discovered) {
    const model = normalizeModelDescriptor(raw);
    next.set(model.providerId + "::" + model.id, model);
  }
  // A provider's successful discovery is authoritative. Only models explicitly returned survive.
  return [...next.values()].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.displayName.localeCompare(b.displayName));
}

export function selectAvailableModel(models: readonly ModelDescriptor[], requirement: ModelRequirement = {}): ModelSelection | null {
  const required = new Set(requirement.capabilities ?? ["text"]);
  for (const capability of required) if (!CAPABILITIES.has(capability)) throw new TypeError("Unknown required model capability: " + capability);
  const candidates = models.filter(model =>
    model.available && model.installed &&
    (!requirement.providerIds?.length || requirement.providerIds.includes(model.providerId)) &&
    [...required].every(capability => model.capabilities.includes(capability)) &&
    (requirement.minimumContextWindow === undefined || (model.contextWindow ?? 0) >= requirement.minimumContextWindow)
  );
  if (!candidates.length) return null;
  const scored = candidates.map(model => {
    let score = 100;
    const reasons = ["Model is currently available and installed.", "All required capabilities are present."];
    if (requirement.minimumContextWindow !== undefined) {
      score += Math.min(20, Math.floor((model.contextWindow ?? 0) / requirement.minimumContextWindow));
      reasons.push("Context window satisfies the requested minimum.");
    }
    if (requirement.preferLocal && model.providerKind === "local") { score += 15; reasons.push("Local execution preference satisfied."); }
    if (model.source === "live-discovery") { score += 5; reasons.push("Availability confirmed by live discovery."); }
    return { model, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score || a.model.providerId.localeCompare(b.model.providerId) || a.model.id.localeCompare(b.model.id));
  return scored[0];
}

export function summarizeProviderReadiness(providers: readonly ModelProvider[], models: readonly ModelDescriptor[]) {
  return providers.map(provider => {
    const providerModels = models.filter(model => model.providerId === provider.id);
    const availableModels = providerModels.filter(model => model.available && model.installed);
    return {
      id: provider.id, kind: provider.kind, label: provider.label,
      configured: provider.configured, connected: provider.connected,
      modelCount: providerModels.length, availableModelCount: availableModels.length,
      status: !provider.configured ? "needs-configuration" as const
        : !provider.connected ? "disconnected" as const
        : availableModels.length ? "ready" as const : "no-models" as const,
      ...(provider.error ? { error: provider.error.slice(0, 500) } : {}),
      ...(provider.lastCheckedAt ? { lastCheckedAt: provider.lastCheckedAt } : {}),
    };
  });
}
