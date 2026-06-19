import "server-only";

import { setDocTranslation, setDocTranslationStatus } from "@/lib/db";

/**
 * HTML-preserving translation to Simplified Chinese via DeepSeek
 * (OpenAI-compatible chat completions API).
 *
 * Strategy: tokenize the document into tags vs. text nodes, translate only the
 * meaningful text nodes in batches, and splice the translations back into the
 * exact same positions. This keeps every tag, attribute, and inline asset
 * reference untouched, so the page's layout/format is preserved.
 */

const ENDPOINT_BASE =
  (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(
    /\/+$/,
    ""
  );
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

// Elements whose contents must never be translated (code, scripts, vectors…).
const RAW_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "math",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "textarea",
  "template",
]);

// Tuning knobs — keep requests small enough to stay reliable & bounded.
const BATCH_CHARS = 1400;
const MAX_TRANSLATABLE_CHARS = 200_000; // hard cap to bound cost/latency
const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 60_000;

type TextToken = { kind: "text"; value: string };
type RawToken = { kind: "raw"; value: string };
type Token = TextToken | RawToken;

export function deepseekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

/** Split HTML into a flat list of raw (tags/comments/raw-elements) and text tokens. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const pushText = (value: string) => {
    if (value) tokens.push({ kind: "text", value });
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    // HTML comment
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? html.length : end + 3;
      tokens.push({ kind: "raw", value: html.slice(lt, stop) });
      i = stop;
      continue;
    }

    // Declarations / processing instructions: <!DOCTYPE …>, <?xml …?>.
    // These are markup, never translatable text.
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      const stop = end === -1 ? html.length : end + 1;
      tokens.push({ kind: "raw", value: html.slice(lt, stop) });
      i = stop;
      continue;
    }

    const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt));
    if (!tagMatch) {
      // Stray "<" that isn't a tag — treat as literal text.
      pushText("<");
      i = lt + 1;
      continue;
    }

    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      pushText(html.slice(lt));
      break;
    }

    const name = tagMatch[1].toLowerCase();
    const isClose = html[lt + 1] === "/";
    const selfClose = html[gt - 1] === "/";

    if (!isClose && !selfClose && RAW_ELEMENTS.has(name)) {
      // Consume the whole element verbatim, up to its matching close tag.
      const closeRe = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(gt + 1);
      const cm = closeRe.exec(rest);
      const stop = cm ? gt + 1 + cm.index + cm[0].length : html.length;
      tokens.push({ kind: "raw", value: html.slice(lt, stop) });
      i = stop;
      continue;
    }

    tokens.push({ kind: "raw", value: html.slice(lt, gt + 1) });
    i = gt + 1;
  }
  return tokens;
}

/** Only translate text that actually contains a letter (skip whitespace/punct/numbers). */
function isTranslatable(text: string): boolean {
  return /\p{L}/u.test(text);
}

interface Segment {
  tokenIndex: number;
  lead: string;
  core: string;
  trail: string;
}

function splitWhitespace(value: string): {
  lead: string;
  core: string;
  trail: string;
} {
  const leadMatch = value.match(/^\s*/);
  const trailMatch = value.match(/\s*$/);
  const lead = leadMatch ? leadMatch[0] : "";
  const trail = trailMatch ? trailMatch[0] : "";
  const core = value.slice(lead.length, value.length - trail.length);
  return { lead, core, trail };
}

async function callDeepSeek(
  apiKey: string,
  sources: string[]
): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 1.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a professional translator. You receive a JSON object " +
              '{"src": string[]} of text fragments extracted from an HTML page. ' +
              "Translate every fragment into natural Simplified Chinese. Rules: " +
              "(1) Keep the array length and order identical. " +
              "(2) Preserve HTML entities (e.g. &amp;, &nbsp;, &#39;) exactly. " +
              "(3) Do not add, remove, or reorder fragments, and never add tags or explanations. " +
              "(4) If a fragment is a proper noun, code identifier, URL, or already Chinese, keep it as-is. " +
              'Respond ONLY with JSON: {"dst": string[]}.',
          },
          { role: "user", content: JSON.stringify({ src: sources }) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { dst?: unknown };
    if (!Array.isArray(parsed.dst)) return null;
    if (parsed.dst.length !== sources.length) return null;
    return parsed.dst.map((v) => (typeof v === "string" ? v : ""));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function translateBatch(
  apiKey: string,
  segments: Segment[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const sources = segments.map((s) => s.core);
  let result = await callDeepSeek(apiKey, sources);
  if (!result) result = await callDeepSeek(apiKey, sources); // one retry
  if (!result) return out; // give up on this batch → keep originals
  segments.forEach((seg, idx) => {
    const translated = result![idx];
    if (translated && translated.trim()) out.set(seg.tokenIndex, translated);
  });
  return out;
}

async function runPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  size: number
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

/**
 * Translate the readable text of an HTML document into Simplified Chinese while
 * preserving its structure. Returns the original HTML untouched if DeepSeek is
 * not configured or the request fails, so import never hard-fails on this step.
 */
export async function translateHtmlToChinese(
  html: string
): Promise<{ html: string; translated: boolean }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { html, translated: false };

  const tokens = tokenize(html);

  // Collect translatable segments, respecting the global character cap.
  const segments: Segment[] = [];
  let budget = MAX_TRANSLATABLE_CHARS;
  for (let idx = 0; idx < tokens.length; idx++) {
    const token = tokens[idx];
    if (token.kind !== "text" || !isTranslatable(token.value)) continue;
    const { lead, core, trail } = splitWhitespace(token.value);
    if (!core || !isTranslatable(core)) continue;
    if (budget - core.length < 0) break;
    budget -= core.length;
    segments.push({ tokenIndex: idx, lead, core, trail });
  }

  if (segments.length === 0) return { html, translated: false };

  // Pack segments into char-bounded batches.
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let currentChars = 0;
  for (const seg of segments) {
    if (current.length && currentChars + seg.core.length > BATCH_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(seg);
    currentChars += seg.core.length;
  }
  if (current.length) batches.push(current);

  const translations = new Map<number, string>();
  await runPool(
    batches,
    async (batch) => {
      const result = await translateBatch(apiKey, batch);
      result.forEach((value, tokenIndex) => translations.set(tokenIndex, value));
    },
    CONCURRENCY
  );

  if (translations.size === 0) return { html, translated: false };

  // Re-assemble, swapping in translated cores and keeping original whitespace.
  const segByIndex = new Map(segments.map((s) => [s.tokenIndex, s]));
  const rebuilt = tokens
    .map((token, idx) => {
      const replacement = translations.get(idx);
      if (replacement === undefined) return token.value;
      const seg = segByIndex.get(idx);
      if (!seg) return token.value;
      return `${seg.lead}${replacement}${seg.trail}`;
    })
    .join("");

  return { html: rebuilt, translated: true };
}

/**
 * Fire-and-forget: translate a saved doc and persist the result. Updates the
 * doc's translation_status to "translated" on success or "failed" otherwise.
 * Never throws — intended to be called without awaiting from a route handler.
 */
export async function translateDocInBackground(
  userId: string,
  docId: string,
  html: string
): Promise<void> {
  try {
    const { html: zh, translated } = await translateHtmlToChinese(html);
    if (translated) {
      setDocTranslation(userId, docId, zh);
    } else {
      setDocTranslationStatus(userId, docId, "failed");
    }
  } catch {
    try {
      setDocTranslationStatus(userId, docId, "failed");
    } catch {
      // swallow — nothing else we can do in a background task
    }
  }
}
