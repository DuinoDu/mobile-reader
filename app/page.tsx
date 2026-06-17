import { redirect } from "next/navigation";
import ReaderHome from "@/app/reader-home";
import { getCurrentUser, toPublicUser } from "@/lib/auth";
import { listDocsForUser } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const docs = listDocsForUser(user.id);
  return <ReaderHome initialDocs={docs} user={toPublicUser(user)} />;
}
