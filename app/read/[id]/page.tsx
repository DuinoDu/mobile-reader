"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { useParams, useRouter } from "next/navigation";
import {
  addComment,
  deleteComment,
  getDocRecord,
  listComments,
  translateDoc,
  updateComment,
  type CommentAnchor,
  type ReaderComment,
} from "@/lib/storage";
import type { TranslationStatus } from "@/lib/types";

type FrameRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type PendingSelection = {
  text: string;
  anchor: CommentAnchor;
  button: {
    top: number;
    left: number;
  };
};

type FrameMessage =
  | {
      source: "mobile-reader-frame";
      type: "ready";
    }
  | {
      source: "mobile-reader-frame";
      type: "selection";
      text: string;
      anchor: CommentAnchor;
      rect: FrameRect;
    }
  | {
      source: "mobile-reader-frame";
      type: "selection-clear";
    }
  | {
      source: "mobile-reader-frame";
      type: "comment-click";
      id: string;
    };

const READER_BRIDGE = `
<style id="mobile-reader-comment-style">
html, body, body * { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
::selection { background: rgba(113, 113, 122, 0.24); }
::highlight(mr-comment) { background: rgba(161, 161, 170, 0.34); color: inherit; }
::highlight(mr-active-comment) { background: rgba(24, 24, 27, 0.22); color: inherit; text-decoration: underline; text-decoration-thickness: 2px; }
</style>
<script>
(function () {
  var FRAME_SOURCE = "mobile-reader-frame";
  var PARENT_SOURCE = "mobile-reader-parent";
  var rangesById = new Map();
  var activeCommentId = null;
  var selectionTimer = 0;

  function post(message) {
    window.parent.postMessage(Object.assign({ source: FRAME_SOURCE }, message), "*");
  }

  function getPath(node) {
    var path = [];
    var current = node;
    while (current && current !== document.body) {
      var parent = current.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === document.body ? path : null;
  }

  function resolvePath(path) {
    var node = document.body;
    for (var i = 0; i < path.length; i++) {
      if (!node || !node.childNodes || path[i] < 0 || path[i] >= node.childNodes.length) {
        return null;
      }
      node = node.childNodes[path[i]];
    }
    return node;
  }

  function isAnchor(value) {
    return value &&
      Array.isArray(value.startPath) &&
      Array.isArray(value.endPath) &&
      typeof value.startOffset === "number" &&
      typeof value.endOffset === "number";
  }

  function rangeFromAnchor(anchor) {
    if (!isAnchor(anchor)) return null;
    var startNode = resolvePath(anchor.startPath);
    var endNode = resolvePath(anchor.endPath);
    if (!startNode || !endNode) return null;
    try {
      var range = document.createRange();
      range.setStart(startNode, anchor.startOffset);
      range.setEnd(endNode, anchor.endOffset);
      return range.collapsed ? null : range;
    } catch (error) {
      return null;
    }
  }

  function canPaintHighlights() {
    return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
  }

  function paintHighlights() {
    if (!canPaintHighlights()) return;
    CSS.highlights.delete("mr-comment");
    CSS.highlights.delete("mr-active-comment");
    var ranges = Array.from(rangesById.values());
    if (ranges.length) {
      CSS.highlights.set("mr-comment", new Highlight(...ranges));
    }
    if (activeCommentId && rangesById.has(activeCommentId)) {
      CSS.highlights.set("mr-active-comment", new Highlight(rangesById.get(activeCommentId)));
    }
  }

  function syncComments(comments) {
    rangesById.clear();
    if (Array.isArray(comments)) {
      comments.forEach(function (comment) {
        if (!comment || typeof comment.id !== "string") return;
        var range = rangeFromAnchor(comment.anchor);
        if (range) rangesById.set(comment.id, range);
      });
    }
    if (activeCommentId && !rangesById.has(activeCommentId)) {
      activeCommentId = null;
    }
    paintHighlights();
  }

  function getRangeRect(range) {
    var rect = range.getBoundingClientRect();
    if (rect && (rect.width || rect.height)) return rect;
    var first = range.getClientRects()[0];
    return first || rect;
  }

  function reportSelection() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      post({ type: "selection-clear" });
      return;
    }
    var text = selection.toString().replace(/\\s+/g, " ").trim();
    if (!text) {
      post({ type: "selection-clear" });
      return;
    }
    var range = selection.getRangeAt(0);
    if (!document.body || !document.body.contains(range.commonAncestorContainer)) {
      post({ type: "selection-clear" });
      return;
    }
    var startPath = getPath(range.startContainer);
    var endPath = getPath(range.endContainer);
    if (!startPath || !endPath) {
      post({ type: "selection-clear" });
      return;
    }
    var rect = getRangeRect(range);
    post({
      type: "selection",
      text: text,
      anchor: {
        startPath: startPath,
        startOffset: range.startOffset,
        endPath: endPath,
        endOffset: range.endOffset
      },
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }
    });
  }

  function scheduleSelectionReport(delay) {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(reportSelection, typeof delay === "number" ? delay : 90);
  }

  function scheduleTouchSelectionReport() {
    scheduleSelectionReport(120);
    window.setTimeout(reportSelection, 280);
    window.setTimeout(reportSelection, 520);
  }

  function clearSelection() {
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    post({ type: "selection-clear" });
  }

  function rangeAtPoint(x, y) {
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(x, y);
    }
    if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(x, y);
      if (!position) return null;
      var range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function commentIdAtPoint(x, y) {
    var point = rangeAtPoint(x, y);
    if (!point) return null;
    var found = null;
    rangesById.forEach(function (range, id) {
      if (found) return;
      try {
        if (range.isPointInRange(point.startContainer, point.startOffset)) {
          found = id;
        }
      } catch (error) {
      }
    });
    return found;
  }

  function scrollToComment(id) {
    var range = rangesById.get(id);
    if (!range) return;
    activeCommentId = id;
    paintHighlights();
    var rect = getRangeRect(range);
    var top = rect.top - window.innerHeight * 0.35;
    window.scrollBy({ top: top, left: 0, behavior: "smooth" });
  }

  document.addEventListener("mouseup", scheduleSelectionReport);
  document.addEventListener("pointerup", scheduleSelectionReport);
  document.addEventListener("touchend", scheduleTouchSelectionReport, { passive: true });
  document.addEventListener("touchcancel", scheduleTouchSelectionReport, { passive: true });
  document.addEventListener("selectionchange", scheduleSelectionReport);
  document.addEventListener("keyup", scheduleSelectionReport);
  document.addEventListener("click", function (event) {
    var id = commentIdAtPoint(event.clientX, event.clientY);
    if (!id) return;
    activeCommentId = id;
    paintHighlights();
    post({ type: "comment-click", id: id });
  }, true);

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== PARENT_SOURCE) return;
    if (data.type === "sync-comments") {
      syncComments(data.comments);
    }
    if (data.type === "active-comment") {
      activeCommentId = typeof data.id === "string" ? data.id : null;
      paintHighlights();
    }
    if (data.type === "scroll-to-comment" && typeof data.id === "string") {
      scrollToComment(data.id);
    }
    if (data.type === "clear-selection") {
      clearSelection();
    }
  });

  post({ type: "ready" });
})();
</script>`;

function withReaderBridge(html: string): string {
  const bodyClosePattern = /<\/body>/i;
  if (bodyClosePattern.test(html)) {
    return html.replace(bodyClosePattern, `${READER_BRIDGE}</body>`);
  }
  return `${html}${READER_BRIDGE}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isAnchor(value: unknown): value is CommentAnchor {
  return (
    isPlainObject(value) &&
    isNumberArray(value.startPath) &&
    isNumberArray(value.endPath) &&
    typeof value.startOffset === "number" &&
    typeof value.endOffset === "number"
  );
}

function isFrameRect(value: unknown): value is FrameRect {
  return (
    isPlainObject(value) &&
    typeof value.top === "number" &&
    typeof value.left === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function isFrameMessage(value: unknown): value is FrameMessage {
  if (!isPlainObject(value) || value.source !== "mobile-reader-frame") {
    return false;
  }
  if (value.type === "ready" || value.type === "selection-clear") return true;
  if (value.type === "comment-click") return typeof value.id === "string";
  return (
    value.type === "selection" &&
    typeof value.text === "string" &&
    isAnchor(value.anchor) &&
    isFrameRect(value.rect)
  );
}

function formatCommentTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ReaderPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [html, setHtml] = useState<string | null>(null);
  const [htmlZh, setHtmlZh] = useState<string | null>(null);
  const [translationStatus, setTranslationStatus] =
    useState<TranslationStatus>("none");
  const [view, setView] = useState<"zh" | "original">("original");
  const [title, setTitle] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "missing">(
    "loading"
  );
  const [comments, setComments] = useState<ReaderComment[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const frameHtml = useMemo(() => {
    const src = view === "zh" && htmlZh ? htmlZh : html;
    return src ? withReaderBridge(src) : "";
  }, [view, htmlZh, html]);

  const selectionButtonStyle = useMemo<CSSProperties | undefined>(() => {
    if (!pendingSelection) return undefined;
    return {
      top: pendingSelection.button.top,
      left: pendingSelection.button.left,
    };
  }, [pendingSelection]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const startTranslation = useCallback(async () => {
    try {
      await translateDoc(id);
      setTranslationStatus("translating");
      showToast("已开始翻译…");
    } catch {
      showToast("无法开始翻译");
    }
  }, [id, showToast]);

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(
      { source: "mobile-reader-parent", ...message },
      "*"
    );
  }, []);

  const syncCommentsToFrame = useCallback(() => {
    postToFrame({ type: "sync-comments", comments });
  }, [comments, postToFrame]);

  useEffect(() => {
    let active = true;
    setState("loading");
    setHtml(null);
    setHtmlZh(null);
    setTranslationStatus("none");
    setView("original");
    setComments([]);
    setPendingSelection(null);
    setComposerOpen(false);
    setActiveCommentId(null);
    (async () => {
      try {
        const [record, savedComments] = await Promise.all([
          getDocRecord(id),
          listComments(id),
        ]);
        if (!active) return;
        if (!record) {
          setState("missing");
          return;
        }
        setHtml(record.html);
        setHtmlZh(record.htmlZh);
        setTranslationStatus(record.translationStatus);
        setView(record.htmlZh ? "zh" : "original");
        setTitle(record.title);
        setComments(savedComments);
        setState("ready");
      } catch {
        if (active) setState("missing");
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  // While translating in the background, poll until the Chinese version lands.
  useEffect(() => {
    if (translationStatus !== "translating") return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const record = await getDocRecord(id);
        if (!active || !record) return;
        setTranslationStatus(record.translationStatus);
        if (record.htmlZh) {
          setHtmlZh(record.htmlZh);
          setView("zh");
        }
      } catch {
        // keep polling; transient failure
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [translationStatus, id]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!isFrameMessage(event.data)) return;

      if (event.data.type === "ready") {
        syncCommentsToFrame();
        if (activeCommentId) {
          postToFrame({ type: "active-comment", id: activeCommentId });
        }
        return;
      }

      if (event.data.type === "selection-clear") {
        setPendingSelection(null);
        return;
      }

      if (event.data.type === "comment-click") {
        setActiveCommentId(event.data.id);
        setPendingSelection(null);
        setComposerOpen(false);
        setCommentsOpen(true);
        return;
      }

      const frameRect = frameRef.current?.getBoundingClientRect();
      if (!frameRect) return;
      const selectionTop = frameRect.top + event.data.rect.top;
      const selectionLeft =
        frameRect.left + event.data.rect.left + event.data.rect.width / 2;
      const belowTop =
        frameRect.top + event.data.rect.top + event.data.rect.height + 8;
      const desiredTop = selectionTop - 42;
      // On mobile/touch the native selection menu covers the area above the
      // selection, so anchor the comment button below the selection instead.
      const isTouch =
        typeof window !== "undefined" &&
        (window.matchMedia?.("(pointer: coarse)").matches ||
          "ontouchstart" in window);
      const top = isTouch
        ? belowTop
        : Math.max(58, desiredTop < 58 ? belowTop : desiredTop);
      const left = Math.min(
        window.innerWidth - 82,
        Math.max(12, selectionLeft - 34)
      );
      setPendingSelection({
        text: event.data.text,
        anchor: event.data.anchor,
        button: { top, left },
      });
      setActiveCommentId(null);
      setComposerOpen(false);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [activeCommentId, postToFrame, syncCommentsToFrame]);

  useEffect(() => {
    if (state === "ready") syncCommentsToFrame();
  }, [state, syncCommentsToFrame]);

  useEffect(() => {
    postToFrame({ type: "active-comment", id: activeCommentId });
  }, [activeCommentId, postToFrame]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const openComposer = useCallback(() => {
    if (!pendingSelection) return;
    setNote("");
    setComposerOpen(true);
  }, [pendingSelection]);

  const openComposerFromPress = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      openComposer();
    },
    [openComposer]
  );

  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setNote("");
    setPendingSelection(null);
    postToFrame({ type: "clear-selection" });
  }, [postToFrame]);

  const saveComment = useCallback(async () => {
    if (!pendingSelection || !note.trim()) return;
    try {
      const saved = await addComment({
        docId: id,
        quote: pendingSelection.text,
        note,
        anchor: pendingSelection.anchor,
      });
      setComments((current) => [saved, ...current]);
      setActiveCommentId(saved.id);
      setComposerOpen(false);
      setPendingSelection(null);
      setNote("");
      postToFrame({ type: "clear-selection" });
      showToast("评论已保存");
    } catch {
      showToast("评论保存失败");
    }
  }, [id, note, pendingSelection, postToFrame, showToast]);

  const focusComment = useCallback(
    (comment: ReaderComment) => {
      setActiveCommentId(comment.id);
      postToFrame({ type: "scroll-to-comment", id: comment.id });
    },
    [postToFrame]
  );

  const startEdit = useCallback((comment: ReaderComment) => {
    setEditingId(comment.id);
    setEditingNote(comment.note);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId || !editingNote.trim()) return;
    try {
      const updated = await updateComment(editingId, editingNote);
      if (updated) {
        setComments((current) =>
          current.map((comment) =>
            comment.id === updated.id ? updated : comment
          )
        );
      }
      setEditingId(null);
      setEditingNote("");
      showToast("评论已更新");
    } catch {
      showToast("评论更新失败");
    }
  }, [editingId, editingNote, showToast]);

  const removeComment = useCallback(
    async (comment: ReaderComment) => {
      try {
        await deleteComment(comment.id);
        setComments((current) =>
          current.filter((item) => item.id !== comment.id)
        );
        if (activeCommentId === comment.id) setActiveCommentId(null);
        if (editingId === comment.id) {
          setEditingId(null);
          setEditingNote("");
        }
        showToast("评论已删除");
      } catch {
        showToast("评论删除失败");
      }
    },
    [activeCommentId, editingId, showToast]
  );

  if (state === "loading") {
    return (
      <div className="centered">
        <div>
          <div className="spinner" />
          加载中…
        </div>
      </div>
    );
  }

  if (state === "missing") {
    return (
      <div className="centered">
        <div>
          <p style={{ fontSize: 30, margin: "0 0 8px" }}>🗒️</p>
          <p>找不到这篇文档，可能已被删除。</p>
          <a className="upload-btn" style={{ marginTop: 16 }} href="/">
            返回阅读列表
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="reader-root">
      <div className="reader-bar">
        <button
          className="back"
          aria-label="返回列表"
          title="返回列表"
          onClick={() => router.push("/")}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="doc-title">{title}</span>
        {(htmlZh || translationStatus === "translating") && (
          <button
            className="reader-view-toggle"
            disabled={!htmlZh}
            aria-pressed={view === "zh"}
            onClick={() =>
              setView((v) => (v === "zh" ? "original" : "zh"))
            }
            title={htmlZh ? "切换原文 / 中文译文" : "正在翻译"}
          >
            {!htmlZh && translationStatus === "translating"
              ? "翻译中…"
              : view === "zh"
                ? "原文"
                : "译文"}
          </button>
        )}
        {!htmlZh &&
          (translationStatus === "none" || translationStatus === "failed") && (
            <button className="reader-view-toggle" onClick={startTranslation}>
              {translationStatus === "failed" ? "重试翻译" : "翻译成中文"}
            </button>
          )}
        <button
          className="reader-comments-toggle"
          aria-pressed={commentsOpen}
          aria-label="评论"
          title="评论"
          onClick={() => setCommentsOpen((open) => !open)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
          </svg>
          {comments.length > 0 && (
            <span className="reader-comments-count">{comments.length}</span>
          )}
        </button>
      </div>
      <iframe
        ref={frameRef}
        className="reader-frame"
        title={title || "文档"}
        srcDoc={frameHtml}
        // Allow the document's own scripts/styles to run, but keep it sandboxed
        // from the app's origin and storage.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="no-referrer"
        onLoad={syncCommentsToFrame}
      />

      {pendingSelection && !composerOpen && (
        <button
          className="selection-comment-btn"
          style={selectionButtonStyle}
          onPointerDown={openComposerFromPress}
          onClick={openComposer}
        >
          评论
        </button>
      )}

      {commentsOpen && (
        <aside className="comments-panel" aria-label="评论">
          <div className="comments-panel-head">
            <strong>评论</strong>
            <button
              className="panel-close"
              aria-label="关闭评论"
              onClick={() => setCommentsOpen(false)}
            >
              ×
            </button>
          </div>
          {comments.length === 0 ? (
            <p className="comment-empty">暂无评论</p>
          ) : (
            <ul className="comment-list">
              {comments.map((comment) => (
                <li
                  key={comment.id}
                  className={`comment-item${
                    activeCommentId === comment.id ? " active" : ""
                  }`}
                >
                  <button
                    className="comment-quote"
                    onClick={() => focusComment(comment)}
                  >
                    “{comment.quote}”
                  </button>
                  {editingId === comment.id ? (
                    <div className="comment-edit">
                      <textarea
                        value={editingNote}
                        onChange={(e) => setEditingNote(e.target.value)}
                        autoFocus
                      />
                      <div className="comment-actions">
                        <button onClick={() => setEditingId(null)}>取消</button>
                        <button
                          className="primary"
                          disabled={!editingNote.trim()}
                          onClick={saveEdit}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="comment-note">{comment.note}</p>
                      <div className="comment-meta">
                        <span>{formatCommentTime(comment.updatedAt)}</span>
                        <button onClick={() => startEdit(comment)}>编辑</button>
                        <button
                          className="danger"
                          onClick={() => removeComment(comment)}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}

      {composerOpen && pendingSelection && (
        <div className="modal-overlay" onClick={closeComposer}>
          <div
            className="modal comment-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>添加评论</h2>
            <blockquote>“{pendingSelection.text}”</blockquote>
            <textarea
              className="comment-textarea"
              value={note}
              autoFocus
              placeholder="写下评论"
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="modal-actions">
              <button className="btn-ghost" onClick={closeComposer}>
                取消
              </button>
              <button
                className="btn-primary"
                disabled={!note.trim()}
                onClick={saveComment}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
