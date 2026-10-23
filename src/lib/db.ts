/** 极简 IndexedDB 封装：只做本应用需要的读写 */
const DB_NAME = 'aibeici';
const DB_VER = 1;

export type StoreName = 'cards' | 'attempts' | 'readings' | 'kv' | 'cache';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('attempts'))
        db.createObjectStore('attempts', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('readings'))
        db.createObjectStore('readings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDB();
  return wrap<T[]>(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return wrap<T | undefined>(
    db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>,
  );
}

export async function idbPut(store: StoreName, value: unknown): Promise<void> {
  const db = await openDB();
  await wrap(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

export async function idbDel(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  await wrap(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDB();
  await wrap(db.transaction(store, 'readwrite').objectStore(store).clear());
}

/* ---------- 键值便捷方法 ---------- */

export async function kvGet<T>(k: string): Promise<T | undefined> {
  const row = await idbGet<{ k: string; v: T }>('kv', k);
  return row?.v;
}

export async function kvSet<T>(k: string, v: T): Promise<void> {
  await idbPut('kv', { k, v });
}

/* ---------- 判分缓存 ---------- */

export async function cacheGet<T>(k: string): Promise<T | undefined> {
  const row = await idbGet<{ k: string; v: T; at: number }>('cache', k);
  return row?.v;
}

export async function cacheSet<T>(k: string, v: T): Promise<void> {
  await idbPut('cache', { k, v, at: Date.now() });
}

export async function cacheClear(): Promise<void> {
  await idbClear('cache');
}
