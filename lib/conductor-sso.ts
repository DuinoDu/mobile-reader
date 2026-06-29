import "server-only";

import type { NextRequest } from "next/server";

export interface ConductorTokenResponse {
  access_token: string;
  token_type: string;
  user: {
    id: string;
    email?: string | null;
    phone?: string | null;
    name?: string | null;
  };
  conductor_base_url?: string | null;
}

export function getConductorBaseUrl(): string {
  return (
    process.env.CONDUCTOR_BASE_URL || "https://conductor.conductor-ai.top"
  ).replace(/\/+$/, "");
}

export function getConductorClientId(): string {
  return process.env.CONDUCTOR_CLIENT_ID || "mobile-reader";
}

export function getConductorClientSecret(): string {
  const secret = process.env.CONDUCTOR_CLIENT_SECRET;
  if (!secret) {
    throw new Error("CONDUCTOR_CLIENT_SECRET is required for Conductor SSO");
  }
  return secret;
}

export function getAppBaseUrl(request: NextRequest): string {
  const configured =
    process.env.MOBILE_READER_BASE_URL || process.env.NEXT_PUBLIC_APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost || request.headers.get("host");
  if (host) {
    const proto = forwardedProto || new URL(request.url).protocol.replace(":", "");
    return `${proto}://${host}`;
  }

  return new URL(request.url).origin;
}

export function getCallbackUrl(request: NextRequest): string {
  return `${getAppBaseUrl(request)}/api/auth/callback`;
}

export function buildAuthorizeUrl(input: {
  request: NextRequest;
  state: string;
}): URL {
  const url = new URL("/oauth/authorize", getConductorBaseUrl());
  url.searchParams.set("client_id", getConductorClientId());
  url.searchParams.set("redirect_uri", getCallbackUrl(input.request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url;
}

export async function exchangeAuthorizationCode(input: {
  request: NextRequest;
  code: string;
}): Promise<ConductorTokenResponse> {
  const response = await fetch(`${getConductorBaseUrl()}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: getConductorClientId(),
      client_secret: getConductorClientSecret(),
      code: input.code,
      redirect_uri: getCallbackUrl(input.request),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Conductor token exchange failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as Partial<ConductorTokenResponse>;
  if (
    !data.access_token ||
    !data.user?.id ||
    !data.token_type ||
    data.token_type.toLowerCase() !== "bearer"
  ) {
    throw new Error("Conductor token response is missing required fields");
  }

  return data as ConductorTokenResponse;
}
