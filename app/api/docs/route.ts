import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUserFromRequest } from "@/lib/auth";
import { addDocForUser, listDocsForUser } from "@/lib/db";
import { translateDocInBackground } from "@/lib/translate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_DOC_BYTES = 12 * 1024 * 1024;

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  const user = getCurrentUserFromRequest(request);
  if (!user) return unauthorized();

  return NextResponse.json({ docs: listDocsForUser(user.id) });
}

export async function POST(request: NextRequest) {
  const user = getCurrentUserFromRequest(request);
  if (!user) return unauthorized();

  let body: { html?: unknown; source?: unknown; translate?: unknown };
  try {
    body = (await request.json()) as {
      html?: unknown;
      source?: unknown;
      translate?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.html !== "string" || typeof body.source !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (Buffer.byteLength(body.html, "utf8") > MAX_DOC_BYTES) {
    return NextResponse.json({ error: "文件过大（>12MB）" }, { status: 413 });
  }

  const translate = body.translate === true;
  const doc = addDocForUser(user.id, body.html, body.source, { translate });

  if (translate) {
    // Fire-and-forget background translation; the client polls for status.
    void translateDocInBackground(user.id, doc.id, body.html);
  }

  return NextResponse.json({ doc }, { status: 201 });
}
