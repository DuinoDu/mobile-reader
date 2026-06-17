import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
  sanitizeReturnTo,
} from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/conductor-sso";

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
  const state = randomBytes(16).toString("hex");
  const next = sanitizeReturnTo(request.nextUrl.searchParams.get("next"));
  const authorizeUrl = buildAuthorizeUrl({ request, state });
  const response = NextResponse.redirect(authorizeUrl);

  response.cookies.set(
    OAUTH_STATE_COOKIE,
    encodeStateCookie({ state, next, createdAt: Date.now() }),
    oauthStateCookieOptions()
  );

  return response;
}
