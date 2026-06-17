import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUserFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB cap
const TIMEOUT_MS = 15_000;

/** Block obvious SSRF targets (loopback, private ranges, link-local/metadata). */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  // IPv4 literal checks
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true;
  }
  // IPv6 unique-local / link-local
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Insert a <base> tag so the document's relative assets resolve when sandboxed. */
function injectBase(html: string, baseUrl: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${baseUrl.replace(/"/g, "%22")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${tag}</head>`);
  }
  return tag + html;
}

export async function GET(request: NextRequest) {
  if (!getCurrentUserFromRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const input = request.nextUrl.searchParams.get("url");
  if (!input) return err("缺少 url 参数");

  let target: URL;
  try {
    target = new URL(input.trim());
  } catch {
    return err("网址格式无效");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return err("仅支持 http / https 链接");
  }
  if (isBlockedHost(target.hostname)) {
    return err("出于安全考虑，禁止访问该地址");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    return err(aborted ? "请求超时" : "无法访问该网址", 502);
  }
  clearTimeout(timer);

  if (!res.ok) return err(`目标返回 ${res.status}`, 502);

  const ctype = res.headers.get("content-type") ?? "";
  if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
    return err(`该链接不是 HTML 页面（${ctype.split(";")[0]}）`);
  }

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > MAX_BYTES) return err("文件过大（>12MB）");

  let html: string;
  try {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return err("文件过大（>12MB）");
    html = new TextDecoder("utf-8").decode(buf);
  } catch {
    return err("读取内容失败", 502);
  }

  const finalUrl = res.url || target.toString();
  return NextResponse.json({ html: injectBase(html, finalUrl), finalUrl });
}
