import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeSecureStorage = registerPlugin('AxiomSecureStorage');
const requestId = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);

function desktopBridge() {
  return typeof window !== 'undefined' && window.axiomDesktop ? window.axiomDesktop : null;
}

function createWebSecureStorage() {
  const DB_NAME = 'axiom-secure-vault';
  const STORE = 'entries';
  let databasePromise;
  const open = () => {
    if (!globalThis.indexedDB) throw new Error('Secure browser storage is unavailable.');
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open secure credential storage.'));
    });
    return databasePromise;
  };
  const transact = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = action(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Secure credential storage failed.'));
      tx.onabort = () => reject(tx.error || new Error('Secure credential storage was aborted.'));
    });
  };
  const getKey = async () => {
    const readKey = () => transact('readonly', store => {
      const request = store.get('__device_key__');
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    });
    const existing = await readKey();
    if (existing) return existing;
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      await transact('readwrite', store => store.add(candidate, '__device_key__'));
      return candidate;
    } catch (error) {
      if (error?.name !== 'ConstraintError') throw error;
      const winner = await readKey();
      if (winner) return winner;
      throw new Error('Could not initialize the browser credential encryption key.');
    }
  };
  const id = (namespace, name) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(namespace) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('Invalid credential namespace or key.');
    return namespace + ':' + name;
  };
  return {
    async get(namespace, name) {
      const encrypted = await transact('readonly', store => {
        const request = store.get(id(namespace, name));
        return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); });
      });
      if (!encrypted) return null;
      const key = await getKey();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.iv }, key, encrypted.data);
      return new TextDecoder().decode(plain);
    },
    async set(namespace, name, value) {
      if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 65536) throw new Error('Credential must be a string no larger than 64 KiB.');
      const key = await getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
      await transact('readwrite', store => store.put({ iv, data }, id(namespace, name)));
    },
    async remove(namespace, name) {
      const key = id(namespace, name);
      const existing = await transact('readonly', store => {
        const request = store.getKey(key);
        return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result !== undefined); request.onerror = () => reject(request.error); });
      });
      if (existing) await transact('readwrite', store => store.delete(key));
      return existing;
    }
  };
}

export function createPlatformAdapter() {
  const desktop = desktopBridge();
  const native = Capacitor.isNativePlatform();
  const nativeIOS = native && Capacitor.getPlatform() === 'ios';
  const platform = desktop ? 'electron' : native ? Capacitor.getPlatform() : 'web';
  const secureStorage = desktop ? {
    get: (namespace, key) => desktop.secureStorage.get(namespace, key),
    set: (namespace, key, value) => desktop.secureStorage.set(namespace, key, value),
    remove: (namespace, key) => desktop.secureStorage.remove(namespace, key)
  } : nativeIOS ? {
    get: (namespace, key) => NativeSecureStorage.get({ namespace, key }).then(result => result.value ?? null),
    set: (namespace, key, value) => NativeSecureStorage.set({ namespace, key, value }),
    remove: (namespace, key) => NativeSecureStorage.remove({ namespace, key }).then(result => result.removed === true)
  } : createWebSecureStorage();

  const files = desktop ? {
    list: relativePath => desktop.project.listFiles(relativePath || ''),
    read: relativePath => desktop.project.readFile(relativePath),
    write: (relativePath, content) => desktop.project.writeFile(relativePath, content)
  } : {
    list: async () => { throw new Error('Project file browsing is not available on this platform adapter yet.'); },
    read: async () => { throw new Error('Project file access is not available on this platform adapter yet.'); },
    write: async () => { throw new Error('Project file editing is not available on this platform adapter yet.'); }
  };

  async function createWorktree(taskId) {
    if (!desktop) throw new Error('Native Git worktree creation is not available on this platform.');
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) throw new Error('Invalid worktree task ID.');
    const id = requestId();
    const project = await desktop.project.bootstrap();
    if (typeof project.workspaceRoot !== 'string' || !project.workspaceRoot) throw new Error('Open a project before creating a Git worktree.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Git worktree creation timed out.')); }, 65000);
      const listener = event => {
        const message = event.data;
        if (!message || message.type !== 'agent-worktree-result' || message.requestId !== id) return;
        cleanup();
        if (message.ok && typeof message.path === 'string') resolve(message.path);
        else reject(new Error(message.error || 'Git worktree creation failed.'));
      };
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', listener); };
      window.addEventListener('message', listener);
      desktop.postMessage({ type: 'create-agent-worktree', requestId: id, taskId, workspaceRoot: project.workspaceRoot });
    });
  }

  return Object.freeze({
    platform,
    capabilities: Object.freeze({
      secureStorage: !!desktop || !!globalThis.crypto?.subtle,
      projectFiles: !!desktop,
      gitWorktrees: !!desktop,
      nativeSpeech: nativeIOS,
      shareTarget: typeof navigator !== 'undefined' && !!navigator.share
    }),
    secureStorage,
    files,
    documents: Object.freeze({
      pick: async options => { if (!nativeIOS) throw new Error('The native document picker is available in the iOS app.'); const result = await NativeSecureStorage.pickDocuments(options || { multiple: true }); return { files: (result.files || []).map(file => ({ ...file, webPath: Capacitor.convertFileSrc(file.path) })) }; }
    }),
    git: Object.freeze({
      listWorkspaces: async () => desktop ? desktop.remoteWorkspace.list() : [],
      createWorktree
    })
  });
}

let cachedAdapter;
export function getPlatformAdapter() {
  if (!cachedAdapter) cachedAdapter = createPlatformAdapter();
  return cachedAdapter;
}
