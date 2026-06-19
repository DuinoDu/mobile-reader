import type { DocMeta, DocRecord } from "@/lib/types";

export type { DocMeta, DocRecord };

export interface CommentAnchor {
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
}

export interface ReaderComment {
  id: string;
  docId: string;
  quote: string;
  note: string;
  anchor: CommentAnchor;
  createdAt: number;
  updatedAt: number;
}

const COMMENT_DB_NAME = "mobile-reader-comments";
const COMMENT_DB_VERSION = 1;
const COMMENT_STORE = "comments";

let commentDbPromise: Promise<IDBDatabase> | null = null;

function openCommentDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  if (!commentDbPromise) {
    commentDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(COMMENT_DB_NAME, COMMENT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const upgradeTx = req.transaction;
        let commentStore: IDBObjectStore;
        if (db.objectStoreNames.contains(COMMENT_STORE) && upgradeTx) {
          commentStore = upgradeTx.objectStore(COMMENT_STORE);
        } else {
          commentStore = db.createObjectStore(COMMENT_STORE, { keyPath: "id" });
        }
        if (!commentStore.indexNames.contains("docId")) {
          commentStore.createIndex("docId", "docId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return commentDbPromise;
}

function commentTx<T>(
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  return openCommentDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(COMMENT_STORE, mode);
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

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data.error === "string" ? data.error : "请求失败，请重试";
    throw new Error(message);
  }

  return data as T;
}

export async function listDocs(): Promise<DocMeta[]> {
  const data = await requestJson<{ docs: DocMeta[] }>("/api/docs");
  return data.docs;
}

export async function getDocRecord(id: string): Promise<DocRecord | null> {
  const data = await requestJson<{ doc: DocRecord }>(`/api/docs/${id}`);
  return data.doc;
}

export async function getContent(id: string): Promise<string | null> {
  const data = await requestJson<{ doc: DocRecord }>(`/api/docs/${id}`);
  return data.doc.html;
}

export async function getMeta(id: string): Promise<DocMeta | null> {
  const data = await requestJson<{ doc: DocRecord }>(`/api/docs/${id}`);
  const { html: _html, htmlZh: _htmlZh, ...meta } = data.doc;
  return meta;
}

export async function addDoc(
  html: string,
  source: string,
  translate = false
): Promise<DocMeta> {
  const data = await requestJson<{ doc: DocMeta }>("/api/docs", {
    method: "POST",
    body: JSON.stringify({ html, source, translate }),
  });
  return data.doc;
}

export async function deleteDoc(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/docs/${id}`, { method: "DELETE" });
  await deleteCommentsForDoc(id);
}

export async function renameDoc(id: string, title: string): Promise<void> {
  await requestJson<{ doc: DocMeta }>(`/api/docs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export async function listComments(docId: string): Promise<ReaderComment[]> {
  const comments = await commentTx("readonly", (t) =>
    reqToPromise(
      t.objectStore(COMMENT_STORE).index("docId").getAll(docId) as IDBRequest<
        ReaderComment[]
      >
    )
  );
  return comments.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addComment(input: {
  docId: string;
  quote: string;
  note: string;
  anchor: CommentAnchor;
}): Promise<ReaderComment> {
  const now = Date.now();
  const comment: ReaderComment = {
    id: crypto.randomUUID(),
    docId: input.docId,
    quote: input.quote.trim(),
    note: input.note.trim(),
    anchor: input.anchor,
    createdAt: now,
    updatedAt: now,
  };
  await commentTx("readwrite", (t) => {
    t.objectStore(COMMENT_STORE).put(comment);
  });
  return comment;
}

async function getComment(id: string): Promise<ReaderComment | null> {
  const rec = await commentTx("readonly", (t) =>
    reqToPromise(
      t.objectStore(COMMENT_STORE).get(id) as IDBRequest<
        ReaderComment | undefined
      >
    )
  );
  return rec ?? null;
}

export async function updateComment(
  id: string,
  note: string
): Promise<ReaderComment | null> {
  const current = await getComment(id);
  if (!current) return null;
  const updated: ReaderComment = {
    ...current,
    note: note.trim(),
    updatedAt: Date.now(),
  };
  await commentTx("readwrite", (t) => {
    t.objectStore(COMMENT_STORE).put(updated);
  });
  return updated;
}

export async function deleteComment(id: string): Promise<void> {
  await commentTx("readwrite", (t) => {
    t.objectStore(COMMENT_STORE).delete(id);
  });
}

async function deleteCommentsForDoc(docId: string): Promise<void> {
  await commentTx("readwrite", (t) => {
    const comments = t.objectStore(COMMENT_STORE).index("docId");
    const cursorReq = comments.openCursor(docId);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}
