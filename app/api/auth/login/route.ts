import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  createUserSession,
  oauthStateCookieOptions,
  sanitizeReturnTo,
  setSessionCookie,
} from "@/lib/auth";
import { buildAuthorizeUrl, getAppBaseUrl } from "@/lib/conductor-sso";
import { getOrCreateDevUser, isDevSsoBypassEnabled } from "@/lib/dev-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StateCookie {
  state: string;
  next: string;
  createdAt: number;
}

function encodeStateCookie(value: StateCookie): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export async function GET(request: NextRequest) {
  const next = sanitizeReturnTo(request.nextUrl.searchParams.get("next"));

  // 本地开发：跳过 Conductor SSO，直接以本地用户登录。
  if (isDevSsoBypassEnabled()) {
    const user = getOrCreateDevUser();
    const session = createUserSession(user.id);
    const response = NextResponse.redirect(new URL(next, getAppBaseUrl(request)));
    setSessionCookie(response, session.token);
    return response;
  }

  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl({ request, state });
  const response = NextResponse.redirect(authorizeUrl);

  response.cookies.set(
    OAUTH_STATE_COOKIE,
    encodeStateCookie({ state, next, createdAt: Date.now() }),
    oauthStateCookieOptions()
  );

  return response;
}
