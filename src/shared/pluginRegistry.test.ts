import { describe, expect, it, vi } from "vitest";
import { AxiomPluginRegistry } from "./pluginRegistry";
import type { AxiomPluginContext } from "./axiomRuntime";
const context: AxiomPluginContext = { workspaceRoot: "/workspace", readFile: async () => "", runCheck: async () => ({ exitCode: 0, output: "" }) };
describe("AxiomPluginRegistry", () => {
  it("registers, activates, lists, and deactivates a plugin", async () => {
    const activate = vi.fn(), deactivate = vi.fn();
    const registry = new AxiomPluginRegistry(context);
    registry.register({ id: "example", version: "1.0.0", description: "example plugin", activate, deactivate });
    await registry.activate("example");
    expect(registry.list()[0].active).toBe(true);
    await registry.deactivate("example");
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(registry.list()[0].active).toBe(false);
  });
  it("rejects duplicate ids and unknown plugins", async () => {
    const registry = new AxiomPluginRegistry(context);
    const plugin = { id: "same", version: "1", description: "", activate: () => {} };
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow(/already registered/);
    await expect(registry.activate("missing")).rejects.toThrow(/Unknown plugin/);
  });
});
