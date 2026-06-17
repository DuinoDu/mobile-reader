"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getContent, getMeta } from "@/lib/storage";

export default function ReaderPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [html, setHtml] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "missing">(
    "loading"
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [content, meta] = await Promise.all([
          getContent(id),
          getMeta(id),
        ]);
        if (!active) return;
        if (content == null) {
          setState("missing");
          return;
        }
        setHtml(content);
        setTitle(meta?.title ?? "");
        setState("ready");
      } catch {
        if (active) setState("missing");
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

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
          <button
            className="upload-btn"
            style={{ marginTop: 16 }}
            onClick={() => router.push("/")}
          >
            返回阅读列表
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="reader-root">
      <div className="reader-bar">
        <button className="back" onClick={() => router.push("/")}>
          ‹ 列表
        </button>
        <span className="doc-title">{title}</span>
      </div>
      <iframe
        className="reader-frame"
        title={title || "文档"}
        srcDoc={html ?? ""}
        // Allow the document's own scripts/styles to run, but keep it sandboxed
        // from the app's origin and storage.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
