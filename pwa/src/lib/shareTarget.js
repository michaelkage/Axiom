const DB_NAME = 'axiom-share-target';
const STORE_NAME = 'payloads';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB is unavailable.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open share storage.'));
  });
}

export async function consumeSharedPayload() {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      let payload = null;
      request.onsuccess = () => {
        const records = request.result || [];
        if (records.length) {
          payload = records.sort((a, b) => b.createdAt - a.createdAt)[0];
          records.forEach(record => store.delete(record.id));
        }
      };
      transaction.oncomplete = () => resolve(payload);
      transaction.onerror = () => reject(transaction.error || new Error('Could not consume shared content.'));
      transaction.onabort = () => reject(transaction.error || new Error('Share handoff was interrupted.'));
    });
  } finally {
    database.close();
  }
}
