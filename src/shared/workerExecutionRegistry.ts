import type { WorkerExecutionProvider } from "./workerExecution";

export interface WorkerExecutionProviderDescriptor {
  id: string;
  capabilities: WorkerExecutionProvider["capabilities"];
}

export interface WorkerExecutionProviderRegistry {
  get(id: string): WorkerExecutionProvider;
  list(): WorkerExecutionProviderDescriptor[];
}

/**
 * Register explicit execution providers. Selection is exact by ID: an unknown
 * provider never silently falls back to another runtime.
 */
export function createWorkerExecutionProviderRegistry(
  providers: readonly WorkerExecutionProvider[],
): WorkerExecutionProviderRegistry {
  const entries = new Map<string, WorkerExecutionProvider>();
  for (const provider of providers) {
    if (!provider || typeof provider !== "object"
      || typeof provider.id !== "string"
      || !/^[a-z][a-z0-9-]{0,63}$/.test(provider.id)) {
      throw new TypeError("Worker execution providers must have a valid lowercase ID.");
    }
    if (entries.has(provider.id)) {
      throw new Error("Duplicate worker execution provider: " + provider.id);
    }
    const capabilities = provider.capabilities;
    if (!capabilities || typeof capabilities.isolatedWorkspaces !== "boolean"
      || !["cooperative", "confirmed"].includes(capabilities.cancellation)
      || typeof capabilities.streamingLogs !== "boolean"
      || typeof provider.execute !== "function") {
      throw new TypeError("Worker execution provider " + provider.id + " has an invalid capability or execution contract.");
    }
    entries.set(provider.id, provider);
  }

  return Object.freeze({
    get(id: string): WorkerExecutionProvider {
      const provider = entries.get(id);
      if (!provider) throw new Error("Worker execution provider is not registered: " + id);
      return provider;
    },
    list(): WorkerExecutionProviderDescriptor[] {
      return [...entries.values()].map(provider => ({
        id: provider.id,
        capabilities: { ...provider.capabilities },
      }));
    },
  });
}
