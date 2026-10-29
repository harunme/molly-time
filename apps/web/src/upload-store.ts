/** Files remain local to this browser and are isolated by signed-in account. */
export type SavedUpload = { id: string; owner: string; file: File; paused: boolean; savedAt: number };
const DATABASE = 'mollytime-upload-recovery';
let opening: Promise<IDBDatabase> | undefined;
function database() {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error('本地上传存储暂不可用'));
  });
  return opening;
}
async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const request = work(tx.objectStore('files'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error || request.error);
  });
}
export const storedUploads = () => transaction('readonly', store => store.getAll()) as Promise<SavedUpload[]>;
export const removeStoredUpload = (id: string) => transaction('readwrite', store => store.delete(id));
export async function saveUpload(upload: SavedUpload) {
  // Avoid filling the device with a second copy when there is insufficient room.
  const quota = await navigator.storage?.estimate?.();
  if (quota?.quota && quota.quota - (quota.usage ?? 0) < upload.file.size * 1.1) throw new Error('本地空间不足');
  return transaction('readwrite', store => store.put(upload));
}
export async function setStoredPause(id: string, paused: boolean) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite'), store = tx.objectStore('files');
    const request = store.get(id);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, paused }); };
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
