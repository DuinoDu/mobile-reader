import { type NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, deleteRequestSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function logout(request: NextRequest): NextResponse {
  deleteRequestSession(request);
  const response = NextResponse.redirect(new URL("/login", request.url));
  clearSessionCookie(response);
  return response;
}

export async function GET(request: NextRequest) {
  return logout(request);
}

export async function POST(request: NextRequest) {
  return logout(request);
}
