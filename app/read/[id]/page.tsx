import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getDocForUser } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ReaderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const doc = getDocForUser(user.id, id);

  if (!doc) {
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
        <a className="back" href="/">
          ‹ 列表
        </a>
        <span className="doc-title">{doc.title}</span>
      </div>
      <iframe
        className="reader-frame"
        title={doc.title || "文档"}
        srcDoc={doc.html}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
