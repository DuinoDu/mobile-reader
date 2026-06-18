import { type NextRequest, NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  createUserSession,
  setSessionCookie,
} from "@/lib/auth";
import { exchangeAuthorizationCode, getAppBaseUrl } from "@/lib/conductor-sso";
import { encryptSecret } from "@/lib/crypto";
import { upsertUserFromConductor } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StateCookie {
  state: string;
  next: string;
  createdAt: number;
}

function loginRedirect(request: NextRequest, error: string): NextResponse {
  const url = new URL("/login", getAppBaseUrl(request));
  url.searchParams.set("error", error);
  const response = NextResponse.redirect(url);
  clearOAuthStateCookie(response);
  return response;
}

function parseStateCookie(value: string | undefined): StateCookie | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<StateCookie>;
    if (
      typeof parsed.state === "string" &&
      typeof parsed.next === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return parsed as StateCookie;
    }
  } catch {
  }
  return null;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expected = parseStateCookie(
    request.cookies.get(OAUTH_STATE_COOKIE)?.value
  );

  if (!code || !state || !expected || state !== expected.state) {
    return loginRedirect(request, "invalid_state");
  }

  try {
    const token = await exchangeAuthorizationCode({ request, code });
    const user = upsertUserFromConductor({
      conductorUserId: token.user.id,
      email: token.user.email ?? null,
      phone: token.user.phone ?? null,
      name: token.user.name ?? null,
      encryptedConductorToken: encryptSecret(token.access_token),
      conductorBaseUrl: token.conductor_base_url ?? null,
    });
    const session = createUserSession(user.id);
    const response = NextResponse.redirect(
      new URL(expected.next, getAppBaseUrl(request))
    );

    setSessionCookie(response, session.token);
    clearOAuthStateCookie(response);
    return response;
  } catch (error) {
    console.error(error);
    return loginRedirect(request, "token_exchange_failed");
  }
}
