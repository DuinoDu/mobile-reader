import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUserFromRequest } from "@/lib/auth";
import { enqueueTranslationJob, getDocForUser } from "@/lib/db";
import { ensureTranslationWorker } from "@/lib/translation-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DocRouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Translate (or re-translate) an existing doc into Simplified Chinese.
 * Works for any doc the user owns — URL imports, uploads, or retrying a
 * failed/partial/stuck translation — by queuing a durable job.
 */
export async function POST(request: NextRequest, context: DocRouteContext) {
  const user = getCurrentUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!enqueueTranslationJob(user.id, id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  ensureTranslationWorker();

  const doc = getDocForUser(user.id, id);
  if (!doc) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { html: _html, htmlZh: _htmlZh, ...meta } = doc;
  return NextResponse.json({ doc: meta }, { status: 202 });
}
