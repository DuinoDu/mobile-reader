import { redirect } from "next/navigation";
import { ReaderLogo } from "@/app/reader-logo";
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
      <section className="login-panel" aria-labelledby="login-title">
        <div className="hero-brand">
          <ReaderLogo />
          <h1 id="login-title" className="visually-hidden">
            登录 Reader
          </h1>
          <p>登录后继续阅读</p>
        </div>
        {error && (
          <p className="login-error">{ERROR_COPY[error] ?? "登录失败。"}</p>
        )}
        <a
          className="login-button"
          href="/api/auth/login"
          aria-label="SSO 登录"
          title="SSO 登录"
        >
          SSO 登录
        </a>
      </section>
    </main>
  );
}
