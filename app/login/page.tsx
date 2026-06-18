import { redirect } from "next/navigation";
import { AnimatedGraphBackground } from "@/app/animated-graph-background";
import { getCurrentUser } from "@/lib/auth";
import { isDevSsoBypassEnabled } from "@/lib/dev-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ERROR_COPY: Record<string, string> = {
  invalid_state: "登录状态已失效，请重新登录。",
  token_exchange_failed: "Conductor 登录失败，请稍后重试。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  // 本地开发：跳过 SSO 页面，直接走直登路由建立会话。
  if (isDevSsoBypassEnabled()) redirect("/api/auth/login");

  const { error } = await searchParams;

  return (
    <main className="login-wrap">
      <AnimatedGraphBackground />
      <div className="login-panel">
        <h1 className="login-title">Reader</h1>
        {error && (
          <p className="login-error">{ERROR_COPY[error] ?? "登录失败。"}</p>
        )}
        <a
          className="login-button"
          href="/api/auth/login"
          aria-label="SSO 登录"
          title="SSO 登录"
        >
          <svg
            className="login-button-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          <span>SSO 登录</span>
        </a>
      </div>
    </main>
  );
}
