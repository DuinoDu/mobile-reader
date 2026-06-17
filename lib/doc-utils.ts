/** Pull a human-readable title out of an HTML document string. */
export function extractTitle(html: string, fallback: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = decodeEntities(stripTags(titleMatch[1]).trim());
    if (title) return title;
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const title = decodeEntities(stripTags(h1Match[1]).trim());
    if (title) return title;
  }

  return fallback;
}

export function normalizeTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 240);
}

export function stripHtmlExtension(source: string): string {
  return source.replace(/\.html?$/i, "") || "未命名文档";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
