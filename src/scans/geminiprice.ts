import type { GradedPrices } from "@grailcard/shared";
import { recordUsage } from "./usage.js";

// Grounded web pricing: Gemini + Google Search reads public listing/sales
// pages and reports the numbers it saw, WITH the URL it read them from.
//
// The model is a retrieval-and-extraction layer here, never a price oracle:
// it is forbidden to answer from memory, and every figure it returns is
// re-fetched and checked against the page it cites before we keep it. A
// number that isn't literally on its own source page is dropped, not
// downweighted. Whatever survives is still labeled `estimated` — it is our
// own reading of the open web, not a pricing API.
//
// This is the LAST resort in the valuation chain: it only runs for cards no
// real feed (PPT, JustTCG, CardGrader, TCGdex) could price.

const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

export type WebComp = {
  price: number;
  grade: string; // raw | psa8 | psa9 | psa10
  url: string;
  title: string;
};

export type WebPricing = {
  graded: GradedPrices | null;
  rawUsd: number | null;
  sampleSize: number;
  citations: { label: string; url: string }[];
};

const TTL_MS = 12 * 3600 * 1000;
const cache = new Map<string, { at: number; v: WebPricing | null }>();

const PROMPT_HEAD = `You are looking up CURRENT market prices for one trading card using Google Search.

HARD RULES:
- Every price you report MUST come from a page you actually retrieved in this search. Never answer from memory or general knowledge.
- Report the number exactly as it is written on that page. Do not round, convert, average, or adjust it.
- USD only. Skip any price in another currency.
- Skip a price if you cannot give the exact URL of the page it appears on.
- Prefer completed/sold prices over asking prices. Prefer this exact card, set, and card number.
- If you find nothing reliable, return {"comps": []}. An empty answer is correct and expected for obscure cards.

Respond with JSON only, no prose, no code fences:
{"comps": [{"price": 123.45, "grade": "raw|psa8|psa9|psa10", "url": "https://...", "title": "short page title"}]}

Card:`;

function normGrade(g: unknown): string | null {
  const s = String(g ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (/psa10|gemmt10|gem10/.test(s)) return "psa10";
  if (/psa9|mint9/.test(s)) return "psa9";
  if (/psa8|nmmt8/.test(s)) return "psa8";
  if (/^(raw|ungraded|loose|nm|nearmint|lp)$/.test(s)) return "raw";
  return null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 100) / 100;
}

/** Strings a price could plausibly be written as on its source page. Kept
 *  deliberately long-form (decimals, thousands separators) — a bare "5"
 *  would match almost any HTML and prove nothing. */
function priceNeedles(p: number): string[] {
  const out = new Set<string>([
    p.toFixed(2),
    Number(p.toFixed(2)).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  ]);
  if (p >= 100) {
    out.add(Math.round(p).toString());
    out.add(Math.round(p).toLocaleString("en-US"));
  }
  return [...out];
}

/** Re-fetch the cited page and confirm the number is really printed on it.
 *  Server-rendered pages pass; JS-rendered ones (TCGplayer, PriceCharting)
 *  usually fail closed, which is the safe direction to fail. */
/** exported for tests */
export async function verifyOnPage(comp: WebComp): Promise<boolean> {
  try {
    const res = await fetch(comp.url, {
      signal: AbortSignal.timeout(7000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 grailcard/0.1",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 2_000_000);
    return priceNeedles(comp.price).some((n) => html.includes(n));
  } catch {
    return false;
  }
}

/** exported for tests */
export function parseComps(text: string): WebComp[] {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed?.comps) ? parsed.comps : [];
  const out: WebComp[] = [];
  for (const r of rows) {
    const price = typeof r?.price === "number" ? r.price : Number(r?.price);
    const grade = normGrade(r?.grade);
    const url = typeof r?.url === "string" ? r.url : "";
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) continue;
    if (!grade || !/^https?:\/\//i.test(url)) continue;
    out.push({
      price: Math.round(price * 100) / 100,
      grade,
      url,
      title: typeof r?.title === "string" && r.title ? r.title.slice(0, 80) : new URL(url).hostname,
    });
    if (out.length >= 12) break;
  }
  return out;
}

async function askGemini(query: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  for (const model of MODELS) {
    try {
      recordUsage("gemini");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${PROMPT_HEAD}\n${query}` }] }],
            // NOTE: the search tool and responseMimeType:application/json do
            // not compose on this endpoint — we parse JSON out of the text.
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0 },
          }),
          signal: AbortSignal.timeout(35000),
        },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as any;
      const parts = body?.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim();
      if (text) return text;
    } catch {
      /* try the next model */
    }
  }
  return null;
}

export async function fetchWebPrices(card: {
  cardId: string;
  name: string;
  setName?: string | null;
  localId?: string | null;
  game?: string | null;
}): Promise<WebPricing | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  if (process.env.WEB_PRICING === "0") return null;

  const hit = cache.get(card.cardId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const query = [
    `name: ${card.name}`,
    card.setName ? `set: ${card.setName}` : null,
    card.localId ? `card number: ${card.localId}` : null,
    card.game ? `game: ${card.game}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const text = await askGemini(query);
  if (!text) return null;

  const claimed = parseComps(text);
  if (claimed.length === 0) {
    cache.set(card.cardId, { at: Date.now(), v: null });
    return null;
  }

  // the citation check: anything not printed on its own source page is gone
  const checks = await Promise.all(claimed.map(verifyOnPage));
  const verified = claimed.filter((_, i) => checks[i]);
  if (verified.length === 0) {
    console.warn(
      `[webprice] ${card.cardId}: ${claimed.length} claimed comps, 0 verified on source pages — discarded`,
    );
    cache.set(card.cardId, { at: Date.now(), v: null });
    return null;
  }

  const at = (g: string) => median(verified.filter((c) => c.grade === g).map((c) => c.price));
  const psa8 = at("psa8");
  const psa9 = at("psa9");
  const psa10 = at("psa10");

  const seen = new Set<string>();
  const citations = verified
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .slice(0, 6)
    .map((c) => ({ label: c.title, url: c.url }));

  const result: WebPricing = {
    graded:
      psa8 == null && psa9 == null && psa10 == null
        ? null
        : { source: "web-search", psa8, psa9, psa10, estimated: true },
    rawUsd: at("raw"),
    sampleSize: verified.length,
    citations,
  };
  console.log(
    `[webprice] ${card.cardId}: ${verified.length}/${claimed.length} comps verified on source pages`,
  );
  cache.set(card.cardId, { at: Date.now(), v: result });
  return result;
}
