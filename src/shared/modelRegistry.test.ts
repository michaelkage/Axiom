import { describe, expect, it } from "vitest";
import { mergeDiscoveredModels, normalizeModelDescriptor, selectAvailableModel, summarizeProviderReadiness, type ModelDescriptor } from "./modelRegistry";
const model = (id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor => ({
  id, providerId: "local", providerKind: "local", displayName: id, capabilities: ["text", "tools"],
  available: true, installed: true, source: "live-discovery", lastSeenAt: 100, ...overrides,
});

describe("capability-aware model registry", () => {
  it("does not invent a model when discovery is empty", () => {
    expect(mergeDiscoveredModels([model("phantom")], [])).toEqual([]);
    expect(selectAvailableModel([])).toBeNull();
  });
  it("selects only installed, available models meeting capability and context requirements", () => {
    const result = selectAvailableModel([
      model("offline", { available: false }),
      model("not-installed", { installed: false }),
      model("text-only", { capabilities: ["text"] }),
      model("vision-large", { capabilities: ["text", "vision"], contextWindow: 128_000 }),
    ], { capabilities: ["text", "vision"], minimumContextWindow: 32_000 });
    expect(result?.model.id).toBe("vision-large");
  });
  it("prefers local providers only when explicitly requested", () => {
    const models = [model("cloud", { providerId: "cloud", providerKind: "openai-compatible" }), model("local")];
    expect(selectAvailableModel(models)?.model.id).toBe("cloud");
    expect(selectAvailableModel(models, { preferLocal: true })?.model.id).toBe("local");
  });
  it("normalizes duplicate capabilities and rejects malformed discovery", () => {
    expect(normalizeModelDescriptor(model("x", { capabilities: ["text", "text"] })).capabilities).toEqual(["text"]);
    expect(() => normalizeModelDescriptor(model("../escape"))).toThrow(/identifier/);
    expect(() => normalizeModelDescriptor(model("x", { capabilities: ["magic" as never] }))).toThrow(/capabilities/);
  });
  it("uses provider readiness states that distinguish no modules from a phantom default", () => {
    expect(summarizeProviderReadiness([
      { id: "local", kind: "local", label: "Local models", configured: true, connected: true },
      { id: "cloud", kind: "openai-compatible", label: "Cloud", configured: false, connected: false },
    ], [])).toMatchObject([{ status: "no-models", availableModelCount: 0 }, { status: "needs-configuration" }]);
  });
  it("keeps only the current authoritative discovery snapshot", () => {
    expect(mergeDiscoveredModels([model("stale")], [model("fresh")]).map(item => item.id)).toEqual(["fresh"]);
  });
});
