import { redirect } from "next/navigation";
import { LogIn } from "lucide-react";
import { AnimatedGraphBackground } from "@/app/animated-graph-background";
import { getCurrentUser } from "@/lib/auth";

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

  const { error } = await searchParams;

  return (
    <main className="login-wrap">
      <AnimatedGraphBackground />
      <div className="login-panel">
        <h1>mobile-reader</h1>
        {error && <p className="login-error">{ERROR_COPY[error] ?? "登录失败。"}</p>}
        <a
          className="login-button"
          href="/api/auth/login"
          aria-label="SSO 登录"
          title="SSO 登录"
        >
          <LogIn className="login-button-icon" aria-hidden="true" />
          <span>SSO 登录</span>
        </a>
      </div>
    </main>
  );
}
