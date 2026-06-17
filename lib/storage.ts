import type { DocMeta, DocRecord } from "@/lib/types";

export type { DocMeta, DocRecord };

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

export async function getContent(id: string): Promise<string | null> {
  const data = await requestJson<{ doc: DocRecord }>(`/api/docs/${id}`);
  return data.doc.html;
}

export async function getMeta(id: string): Promise<DocMeta | null> {
  const data = await requestJson<{ doc: DocRecord }>(`/api/docs/${id}`);
  const { html: _html, ...meta } = data.doc;
  return meta;
}

export async function addDoc(html: string, source: string): Promise<DocMeta> {
  const data = await requestJson<{ doc: DocMeta }>("/api/docs", {
    method: "POST",
    body: JSON.stringify({ html, source }),
  });
  return data.doc;
}

export async function deleteDoc(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/docs/${id}`, { method: "DELETE" });
}

export async function renameDoc(id: string, title: string): Promise<void> {
  await requestJson<{ doc: DocMeta }>(`/api/docs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}
