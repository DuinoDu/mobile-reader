type MimeHeaders = Map<string, string>;

type MimePart = {
  headers: MimeHeaders;
  body: string;
  contentType: string;
  transferEncoding: string;
  contentLocation: string | null;
  contentId: string | null;
};

type MhtmlParseResult = {
  html: string;
  source: string | null;
};

const TEXT_ENCODER = new TextEncoder();

function isMhtmlFile(file: File): boolean {
  return (
    /\.mht(?:ml)?$/i.test(file.name) ||
    file.type === "message/rfc822" ||
    file.type === "multipart/related" ||
    file.type === "application/x-mimearchive"
  );
}

function isHtmlFile(file: File): boolean {
  return /\.html?$/i.test(file.name) || file.type === "text/html";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitHeaderBody(input: string): { header: string; body: string } {
  const match = /\r?\n\r?\n/.exec(input);
  if (!match) return { header: input, body: "" };
  return {
    header: input.slice(0, match.index),
    body: input.slice(match.index + match[0].length),
  };
}

function parseHeaders(input: string): MimeHeaders {
  const headers = new Map<string, string>();
  const unfolded = input.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.set(
      line.slice(0, index).trim().toLowerCase(),
      line.slice(index + 1).trim()
    );
  }
  return headers;
}

function parseHeaderParams(value: string | undefined): {
  value: string;
  params: Map<string, string>;
} {
  if (!value) return { value: "", params: new Map() };
  const pieces: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== "\\") {
      quote = quote === ch ? null : quote ?? ch;
    } else if (ch === ";" && !quote) {
      pieces.push(value.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(value.slice(start));

  const params = new Map<string, string>();
  for (const piece of pieces.slice(1)) {
    const index = piece.indexOf("=");
    if (index <= 0) continue;
    const key = piece.slice(0, index).trim().toLowerCase();
    let paramValue = piece.slice(index + 1).trim();
    if (
      (paramValue.startsWith('"') && paramValue.endsWith('"')) ||
      (paramValue.startsWith("'") && paramValue.endsWith("'"))
    ) {
      paramValue = paramValue.slice(1, -1);
    }
    params.set(key, paramValue);
  }

  return { value: pieces[0].trim().toLowerCase(), params };
}

function splitMimeParts(input: string, boundary: string): string[] {
  const parts: string[] = [];
  const pattern = new RegExp(
    `(^|\\r?\\n)--${escapeRegex(boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`,
    "g"
  );
  let previousEnd = 0;
  let seenBoundary = false;
  let previousWasFinal = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input))) {
    if (seenBoundary && !previousWasFinal) {
      parts.push(input.slice(previousEnd, match.index).replace(/\r?\n$/, ""));
    }
    seenBoundary = true;
    previousWasFinal = match[2] === "--";
    previousEnd = pattern.lastIndex;
    if (previousWasFinal) break;
  }

  return parts;
}

function parseMimePart(input: string): MimePart {
  const { header, body } = splitHeaderBody(input);
  const headers = parseHeaders(header);
  const contentType = parseHeaderParams(headers.get("content-type")).value;
  const transferEncoding =
    headers.get("content-transfer-encoding")?.toLowerCase() ?? "7bit";
  const rawContentId = headers.get("content-id")?.trim() ?? null;
  const contentId = rawContentId?.replace(/^<|>$/g, "") ?? null;

  return {
    headers,
    body,
    contentType,
    transferEncoding,
    contentLocation: headers.get("content-location")?.trim() ?? null,
    contentId,
  };
}

function decodeBase64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function quotedPrintableToBytes(input: string): Uint8Array {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const hex = normalized.slice(i + 1, i + 3);
    if (ch === "=" && /^[\da-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    const code = normalized.charCodeAt(i);
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      bytes.push(...TEXT_ENCODER.encode(ch));
    }
  }
  return new Uint8Array(bytes);
}

function textDecoderFor(contentType: string): TextDecoder {
  const charset = parseHeaderParams(contentType).params.get("charset") ?? "utf-8";
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder("utf-8");
  }
}

function decodePartBytes(part: MimePart): Uint8Array {
  if (part.transferEncoding === "base64") return decodeBase64ToBytes(part.body);
  if (part.transferEncoding === "quoted-printable") {
    return quotedPrintableToBytes(part.body);
  }
  return TEXT_ENCODER.encode(part.body);
}

function decodePartText(part: MimePart): string {
  return textDecoderFor(part.headers.get("content-type") ?? "").decode(
    decodePartBytes(part)
  );
}

function isSkippableUrl(value: string): boolean {
  return (
    !value ||
    value.startsWith("#") ||
    /^(?:data|blob|javascript|mailto|tel|about):/i.test(value)
  );
}

function normalizeResourceUrl(value: string, base: string | null): string | null {
  const trimmed = value.trim();
  if (isSkippableUrl(trimmed)) return null;
  try {
    return new URL(trimmed, base ?? undefined).href;
  } catch {
    return trimmed;
  }
}

function withoutHash(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value.split("#", 1)[0];
  }
}

function contentTypeForDataUrl(part: MimePart): string {
  return part.contentType || "application/octet-stream";
}

function replaceCssUrls(
  css: string,
  base: string | null,
  resolveDataUrl: (url: string, base: string | null) => string | null
): string {
  const withUrls = css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi,
    (match, doubleQuoted: string, singleQuoted: string, bare: string) => {
      const url = doubleQuoted ?? singleQuoted ?? bare ?? "";
      const dataUrl = resolveDataUrl(url, base);
      return dataUrl ? `url("${dataUrl}")` : match;
    }
  );

  return withUrls.replace(
    /@import\s+(["'])(.*?)\1/gi,
    (match, quote: string, url: string) => {
      const dataUrl = resolveDataUrl(url, base);
      return dataUrl ? `@import ${quote}${dataUrl}${quote}` : match;
    }
  );
}

function replaceSrcset(
  value: string,
  base: string | null,
  resolveDataUrl: (url: string, base: string | null) => string | null
): string {
  return value
    .split(",")
    .map((candidate) => {
      const match = /^(\s*)(\S+)(.*)$/.exec(candidate);
      if (!match) return candidate;
      const dataUrl = resolveDataUrl(match[2], base);
      return dataUrl ? `${match[1]}${dataUrl}${match[3]}` : candidate;
    })
    .join(",");
}

function replaceHtmlResources(
  html: string,
  base: string | null,
  resolveDataUrl: (url: string, base: string | null) => string | null
): string {
  let out = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, open: string, css: string, close: string) =>
      `${open}${replaceCssUrls(css, base, resolveDataUrl)}${close}`
  );

  out = out.replace(
    /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, raw: string, doubleQuoted: string, singleQuoted: string) => {
      const css = doubleQuoted ?? singleQuoted ?? "";
      const next = replaceCssUrls(css, base, resolveDataUrl);
      return next === css ? match : `style=${raw[0]}${next}${raw[0]}`;
    }
  );

  out = out.replace(
    /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (match, attr: string, raw: string, doubleQuoted: string, singleQuoted: string, bare: string) => {
      const url = doubleQuoted ?? singleQuoted ?? bare ?? "";
      const dataUrl = resolveDataUrl(url, base);
      if (!dataUrl) return match;
      const quote = raw.startsWith("'") ? "'" : '"';
      return `${attr}=${quote}${dataUrl}${quote}`;
    }
  );

  return out.replace(
    /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, raw: string, doubleQuoted: string, singleQuoted: string) => {
      const srcset = doubleQuoted ?? singleQuoted ?? "";
      const next = replaceSrcset(srcset, base, resolveDataUrl);
      return next === srcset ? match : `srcset=${raw[0]}${next}${raw[0]}`;
    }
  );
}

function parseMhtml(input: string): MhtmlParseResult {
  const { header } = splitHeaderBody(input);
  const rootHeaders = parseHeaders(header);
  const rootContentType = parseHeaderParams(rootHeaders.get("content-type"));
  const boundary = rootContentType.params.get("boundary");
  if (!boundary) throw new Error("missing_mhtml_boundary");

  const parts = splitMimeParts(input, boundary).map(parseMimePart);
  const mainPart =
    parts.find((part) => part.contentType === "text/html") ?? parts[0];
  if (!mainPart) throw new Error("empty_mhtml");

  const snapshotLocation =
    rootHeaders.get("snapshot-content-location")?.trim() ??
    mainPart.contentLocation ??
    null;
  const resourceParts = parts.filter((part) => part !== mainPart);
  const resources = new Map<string, MimePart>();
  const dataUrlCache = new Map<MimePart, string>();
  const building = new Set<MimePart>();

  function addResourceKey(key: string | null, part: MimePart) {
    if (!key) return;
    const normalized = normalizeResourceUrl(key, snapshotLocation);
    resources.set(key, part);
    if (normalized) {
      resources.set(normalized, part);
      resources.set(withoutHash(normalized), part);
    }
  }

  for (const part of resourceParts) {
    addResourceKey(part.contentLocation, part);
    if (part.contentId) addResourceKey(`cid:${part.contentId}`, part);
  }

  function dataUrlForPart(part: MimePart): string | null {
    const cached = dataUrlCache.get(part);
    if (cached) return cached;
    if (building.has(part)) return null;
    building.add(part);

    const mediaType = contentTypeForDataUrl(part);
    let bytes: Uint8Array;
    if (part.contentType === "text/css") {
      const css = replaceCssUrls(
        decodePartText(part),
        part.contentLocation ?? snapshotLocation,
        resolveDataUrl
      );
      bytes = TEXT_ENCODER.encode(css);
    } else {
      bytes = decodePartBytes(part);
    }

    const dataUrl = `data:${mediaType};base64,${bytesToBase64(bytes)}`;
    dataUrlCache.set(part, dataUrl);
    building.delete(part);
    return dataUrl;
  }

  function resolveDataUrl(url: string, base: string | null): string | null {
    const normalized = normalizeResourceUrl(url, base);
    if (!normalized) return null;
    const part =
      resources.get(url.trim()) ??
      resources.get(normalized) ??
      resources.get(withoutHash(normalized));
    return part ? dataUrlForPart(part) : null;
  }

  const html = replaceHtmlResources(
    decodePartText(mainPart),
    mainPart.contentLocation ?? snapshotLocation,
    resolveDataUrl
  );

  return { html, source: snapshotLocation };
}

export async function readOfflineFile(file: File): Promise<{
  html: string;
  source: string;
}> {
  if (isMhtmlFile(file)) {
    const parsed = parseMhtml(await file.text());
    return { html: parsed.html, source: parsed.source ?? file.name };
  }
  if (isHtmlFile(file)) {
    return { html: await file.text(), source: file.name };
  }
  throw new Error("unsupported_file_type");
}

export function isSupportedOfflineFile(file: File): boolean {
  return isHtmlFile(file) || isMhtmlFile(file);
}

export const OFFLINE_FILE_ACCEPT =
  ".html,.htm,.mhtml,.mht,text/html,message/rfc822,multipart/related,application/x-mimearchive";
