import type { AxiomPlugin, AxiomPluginContext } from "./axiomRuntime";
export class AxiomPluginRegistry {
  private plugins = new Map<string, AxiomPlugin>();
  private active = new Set<string>();
  constructor(private readonly context: AxiomPluginContext) {}
  register(plugin: AxiomPlugin): void {
    if (!plugin.id.trim()) throw new Error("Plugin id is required.");
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }
  list(): Array<{ id: string; version: string; description: string; active: boolean }> {
    return [...this.plugins.values()].map(plugin => ({ id: plugin.id, version: plugin.version, description: plugin.description, active: this.active.has(plugin.id) }));
  }
  async activate(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    if (this.active.has(id)) return;
    await plugin.activate(this.context);
    this.active.add(id);
  }
  async deactivate(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    if (!this.active.has(id)) return;
    await plugin.deactivate?.();
    this.active.delete(id);
  }
  async dispose(): Promise<void> {
    const activeIds = [...this.active].reverse();
    const errors: string[] = [];
    for (const id of activeIds) {
      try { await this.deactivate(id); }
      catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (errors.length) throw new Error(`Plugin shutdown errors: ${errors.join("; ")}`);
  }
}
