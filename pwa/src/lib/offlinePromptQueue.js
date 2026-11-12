import { redactSecrets } from "./securityRedaction.js";
const DB_NAME = "axiom-offline-queue";
const STORE = "pending";
const MAX_ITEMS = 50;
const MAX_BYTES_PER_ITEM = 2 * 1024 * 1024;

function openDatabase(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.reject(new Error("Offline queue storage is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the offline queue."));
  });
}

async function transaction(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || new Error("Offline queue transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("Offline queue transaction was aborted."));
  });
}

export function validateOfflinePrompt(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    throw new TypeError("An offline queue item requires a non-empty prompt.");
  }
  const safe = {
    prompt: redactSecrets(payload.prompt).slice(0, 100000),
    attachments: Array.isArray(payload.attachments) ? payload.attachments.slice(0, 8).map(item => {
      if (!item || !["image", "text"].includes(item.kind) || typeof item.name !== "string") throw new TypeError("Invalid offline attachment.");
      return item.kind === "image"
        ? { kind: "image", name: item.name.slice(0, 180), type: String(item.type || "image/jpeg"), size: Number(item.size) || 0, base64: String(item.base64 || "") }
        : { kind: "text", name: item.name.slice(0, 180), type: String(item.type || "text/plain"), size: Number(item.size) || 0, text: redactSecrets(String(item.text || "")) };
    }) : [],
    createdAt: Number.isFinite(payload.createdAt) ? payload.createdAt : Date.now()
  };
  const bytes = new TextEncoder().encode(JSON.stringify(safe)).byteLength;
  if (bytes > MAX_BYTES_PER_ITEM) throw new Error("Offline task exceeds the 2 MiB queue item limit.");
  return safe;
}

export async function enqueueOfflinePrompt(payload) {
  const safe = validateOfflinePrompt(payload);
  const existing = await transaction("readonly", store => store.getAll());
  if (existing.length >= MAX_ITEMS) throw new Error("Offline queue is full. Send or remove queued tasks before adding another.");
  const item = { id: globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2), ...safe, status: "queued" };
  await transaction("readwrite", store => store.add(item));
  return item;
}

export async function listOfflinePrompts() {
  const items = await transaction("readonly", store => store.getAll());
  return (items || []).sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeOfflinePrompt(id) {
  if (typeof id !== "string" || !id) return false;
  await transaction("readwrite", store => store.delete(id));
  return true;
}

export async function clearOfflinePrompts() {
  await transaction("readwrite", store => store.clear());
}

export { MAX_ITEMS as MAX_OFFLINE_QUEUE_ITEMS, MAX_BYTES_PER_ITEM };
