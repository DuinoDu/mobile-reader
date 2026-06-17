import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUserFromRequest } from "@/lib/auth";
import {
  deleteDocForUser,
  getDocForUser,
  renameDocForUser,
} from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DocRouteContext = {
  params: Promise<{ id: string }>;
};

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(request: NextRequest, context: DocRouteContext) {
  const user = getCurrentUserFromRequest(request);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const doc = getDocForUser(user.id, id);
  if (!doc) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ doc });
}

export async function PATCH(request: NextRequest, context: DocRouteContext) {
  const user = getCurrentUserFromRequest(request);
  if (!user) return unauthorized();

  let body: { title?: unknown };
  try {
    body = (await request.json()) as { title?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { id } = await context.params;
  const doc = renameDocForUser(user.id, id, body.title);
  if (!doc) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ doc });
}

export async function DELETE(request: NextRequest, context: DocRouteContext) {
  const user = getCurrentUserFromRequest(request);
  if (!user) return unauthorized();

  const { id } = await context.params;
  if (!deleteDocForUser(user.id, id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
