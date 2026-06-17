import "server-only";

import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { createSession, deleteSession, getUserBySessionToken } from "@/lib/db";
import type { AppUser, PublicUser } from "@/lib/types";

export const SESSION_COOKIE = "mobile_reader_session";
export const OAUTH_STATE_COOKIE = "mobile_reader_oauth_state";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

type CookieSameSite = "strict" | "lax" | "none";

function isSecureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as CookieSameSite,
    secure: isSecureCookie(),
    path: "/",
    maxAge,
  };
}

export function oauthStateCookieOptions(maxAge = OAUTH_STATE_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as CookieSameSite,
    secure: isSecureCookie(),
    path: "/",
    maxAge,
  };
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? getUserBySessionToken(token) : null;
}

export function getCurrentUserFromRequest(request: NextRequest): AppUser | null {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  return token ? getUserBySessionToken(token) : null;
}

export function createUserSession(userId: string): {
  token: string;
  expiresAt: number;
} {
  return createSession(userId);
}

export function deleteRequestSession(request: NextRequest): void {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) deleteSession(token);
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
}

export function clearOAuthStateCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE, "", oauthStateCookieOptions(0));
}

export function toPublicUser(user: AppUser): PublicUser {
  return {
    id: user.id,
    conductorUserId: user.conductorUserId,
    email: user.email,
    phone: user.phone,
    name: user.name,
    displayName: user.displayName,
  };
}

export function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";

  try {
    const url = new URL(value, "https://mobile-reader.local");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
