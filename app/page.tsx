"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addDoc,
  deleteDoc,
  listDocs,
  renameDoc,
  type DocMeta,
} from "@/lib/storage";

function formatDate(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setDocs(await listDocs());
    } catch {
      setDocs([]);
      showToast("无法访问本地存储");
    }
  }, [showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const closeAllMenus = useCallback(() => {
    setOpenMenu(null);
    setConfirmId(null);
    setAddMenu(false);
  }, []);

  // Close any open menu when tapping anywhere outside it (covers the whole
  // viewport, including the body margins that <main> doesn't reach).
  useEffect(() => {
    if (!openMenu && !addMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".menu, .menu-btn, .upload-btn")) return;
      closeAllMenus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu, addMenu, closeAllMenus]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter(
        (f) => /\.html?$/i.test(f.name) || f.type === "text/html"
      );
      if (list.length === 0) {
        showToast("请选择 HTML 文件");
        return;
      }
      let added = 0;
      for (const file of list) {
        try {
          const html = await file.text();
          await addDoc(html, file.name);
          added++;
        } catch {
          showToast(`「${file.name}」读取失败`);
        }
      }
      if (added > 0) {
        await refresh();
        showToast(added === 1 ? "已添加到阅读列表" : `已添加 ${added} 篇`);
      }
    },
    [refresh, showToast]
  );

  const importFromUrl = useCallback(async () => {
    const raw = url.trim();
    if (!raw) return;
    // Be forgiving about a missing scheme.
    const full = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setImporting(true);
    setUrlError(null);
    try {
      const res = await fetch(`/api/fetch-url?url=${encodeURIComponent(full)}`);
      const data = (await res.json()) as {
        html?: string;
        finalUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.html) {
        setUrlError(data.error ?? "导入失败");
        return;
      }
      await addDoc(data.html, data.finalUrl ?? full);
      await refresh();
      setUrlOpen(false);
      setUrl("");
      showToast("已从链接导入");
    } catch {
      setUrlError("网络错误，请重试");
    } finally {
      setImporting(false);
    }
  }, [url, refresh, showToast]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const onRename = useCallback(
    async (doc: DocMeta) => {
      setOpenMenu(null);
      const next = window.prompt("重命名", doc.title);
      if (next && next.trim() && next.trim() !== doc.title) {
        await renameDoc(doc.id, next.trim());
        await refresh();
      }
    },
    [refresh]
  );

  const onDelete = useCallback(
    async (doc: DocMeta) => {
      setOpenMenu(null);
      setConfirmId(null);
      await deleteDoc(doc.id);
      await refresh();
      showToast("已删除");
    },
    [refresh, showToast]
  );

  return (
    <main
      className="wrap"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="hero">
        <div>
          <h1>阅读列表</h1>
          <p>{docs?.length ? `${docs.length} 篇文档` : "添加 HTML 开始阅读"}</p>
        </div>
        <div style={{ position: "relative" }}>
          <button
            className="upload-btn"
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenu(null);
              setAddMenu((v) => !v);
            }}
          >
            ＋ 添加
          </button>
          {addMenu && (
            <div
              className="menu"
              style={{ top: 50 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setAddMenu(false);
                  fileInputRef.current?.click();
                }}
              >
                📄 上传文件
              </button>
              <button
                onClick={() => {
                  setAddMenu(false);
                  setUrlError(null);
                  setUrlOpen(true);
                }}
              >
                🔗 从网址导入
              </button>
            </div>
          )}
        </div>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".html,.htm,text/html"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {docs === null ? (
        <div className="dropzone">加载中…</div>
      ) : docs.length === 0 ? (
        <div
          className={`dropzone${dragging ? " dragging" : ""}`}
          onClick={() => fileInputRef.current?.click()}
        >
          <p style={{ fontSize: 30, margin: "0 0 10px" }}>📄</p>
          <p>
            <strong>点击或拖拽 HTML 文件到此处</strong>
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            也可用「＋ 添加 → 从网址导入」抓取在线页面
          </p>
        </div>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="doc-card"
              style={openMenu === doc.id ? { zIndex: 10 } : undefined}
              onClick={() => router.push(`/read/${doc.id}`)}
            >
              <div className="icon">📄</div>
              <div className="body">
                <p className="title">{doc.title}</p>
                <p className="sub">
                  {formatDate(doc.addedAt)} · {formatSize(doc.size)}
                </p>
              </div>
              <button
                className="menu-btn"
                aria-label="更多操作"
                onClick={(e) => {
                  e.stopPropagation();
                  setAddMenu(false);
                  setConfirmId(null);
                  setOpenMenu(openMenu === doc.id ? null : doc.id);
                }}
              >
                ⋯
              </button>
              {openMenu === doc.id && (
                <div className="menu" onClick={(e) => e.stopPropagation()}>
                  {confirmId === doc.id ? (
                    <>
                      <p className="menu-confirm">确认删除？</p>
                      <button className="danger" onClick={() => onDelete(doc)}>
                        删除
                      </button>
                      <button onClick={() => setConfirmId(null)}>取消</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => router.push(`/read/${doc.id}`)}>
                        打开
                      </button>
                      <button onClick={() => onRename(doc)}>重命名</button>
                      <button
                        className="danger"
                        onClick={() => setConfirmId(doc.id)}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {urlOpen && (
        <div
          className="modal-overlay"
          onClick={() => !importing && setUrlOpen(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2>从网址导入</h2>
            <p className="modal-hint">
              输入网页链接，将抓取该页面的 HTML 加入阅读列表。
            </p>
            <input
              className="url-input"
              type="url"
              inputMode="url"
              autoFocus
              placeholder="https://example.com/article.html"
              value={url}
              disabled={importing}
              onChange={(e) => {
                setUrl(e.target.value);
                if (urlError) setUrlError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !importing) importFromUrl();
              }}
            />
            {urlError && <p className="url-error">{urlError}</p>}
            <div className="modal-actions">
              <button
                className="btn-ghost"
                disabled={importing}
                onClick={() => setUrlOpen(false)}
              >
                取消
              </button>
              <button
                className="btn-primary"
                disabled={importing || !url.trim()}
                onClick={importFromUrl}
              >
                {importing ? "抓取中…" : "导入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
