// Client-side persistence for the reading list, backed by IndexedDB.
// Metadata (for the list) and the (potentially large) HTML content are kept
// in separate object stores so listing never has to load full documents.

export interface DocMeta {
  id: string;
  title: string;
  source: string; // original filename or origin label
  addedAt: number;
  size: number; // bytes of the html string
}

const DB_NAME = "mobile-reader";
const DB_VERSION = 1;
const META_STORE = "meta";
const CONTENT_STORE = "content";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CONTENT_STORE)) {
          db.createObjectStore(CONTENT_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        let result: T;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        Promise.resolve(fn(transaction)).then(
          (r) => {
            result = r;
          },
          (err) => {
            reject(err);
            try {
              transaction.abort();
            } catch {
              // already settled
            }
          }
        );
      })
  );
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Pull a human-readable title out of an HTML document string. */
export function extractTitle(html: string, fallback: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const t = decodeEntities(titleMatch[1].trim());
    if (t) return t;
  }
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const t = decodeEntities(stripTags(h1Match[1]).trim());
    if (t) return t;
  }
  return fallback;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export async function listDocs(): Promise<DocMeta[]> {
  const metas = await tx(META_STORE, "readonly", (t) =>
    reqToPromise(t.objectStore(META_STORE).getAll() as IDBRequest<DocMeta[]>)
  );
  return metas.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getContent(id: string): Promise<string | null> {
  const rec = await tx(CONTENT_STORE, "readonly", (t) =>
    reqToPromise(
      t.objectStore(CONTENT_STORE).get(id) as IDBRequest<{ id: string; html: string } | undefined>
    )
  );
  return rec ? rec.html : null;
}

export async function getMeta(id: string): Promise<DocMeta | null> {
  const rec = await tx(META_STORE, "readonly", (t) =>
    reqToPromise(t.objectStore(META_STORE).get(id) as IDBRequest<DocMeta | undefined>)
  );
  return rec ?? null;
}

export async function addDoc(html: string, source: string): Promise<DocMeta> {
  const id = crypto.randomUUID();
  const meta: DocMeta = {
    id,
    title: extractTitle(html, source.replace(/\.html?$/i, "") || "未命名文档"),
    source,
    addedAt: Date.now(),
    size: new Blob([html]).size,
  };
  await tx([META_STORE, CONTENT_STORE], "readwrite", (t) => {
    t.objectStore(META_STORE).put(meta);
    t.objectStore(CONTENT_STORE).put({ id, html });
  });
  return meta;
}

export async function deleteDoc(id: string): Promise<void> {
  await tx([META_STORE, CONTENT_STORE], "readwrite", (t) => {
    t.objectStore(META_STORE).delete(id);
    t.objectStore(CONTENT_STORE).delete(id);
  });
}

export async function renameDoc(id: string, title: string): Promise<void> {
  const meta = await getMeta(id);
  if (!meta) return;
  meta.title = title;
  await tx(META_STORE, "readwrite", (t) => {
    t.objectStore(META_STORE).put(meta);
  });
}
