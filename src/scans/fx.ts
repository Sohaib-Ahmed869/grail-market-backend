// Currency conversion via frankfurter.app (ECB reference rates, free, no key).
// Cached 24h — ECB publishes once a working day, so anything finer is waste.
//
// Everything downstream prices in USD (TCGplayer, PPT, eBay comps) except
// Cardmarket, which is EUR. Rates are quoted FROM USD, and USD itself is
// included at 1 so callers never special-case the base.

export type FxRates = {
  base: "USD";
  date: string;
  rates: Record<string, number>;
};

const TTL_MS = 24 * 3600 * 1000;

// Enough to keep the picker useful when the network is down. AUD is the
// default display currency, so it matters most that it is present.
const FALLBACK: FxRates = {
  base: "USD",
  date: "1970-01-01",
  rates: { USD: 1, AUD: 1.5, EUR: 0.92, GBP: 0.79, CAD: 1.37, NZD: 1.67, JPY: 157 },
};

let cache: { at: number; v: FxRates } | null = null;
let inflight: Promise<FxRates> | null = null;

async function load(): Promise<FxRates> {
  const res = await fetch("https://api.frankfurter.app/latest?base=USD", {
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
  const raw = body.rates ?? {};

  // keep only sane, finite, positive numbers — a garbage rate silently
  // multiplies every price on the page
  const rates: Record<string, number> = { USD: 1 };
  for (const [code, rate] of Object.entries(raw)) {
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 1_000_000) {
      rates[code] = rate;
    }
  }
  if (!rates.AUD) throw new Error("frankfurter response missing AUD");

  return { base: "USD", date: body.date ?? new Date().toISOString().slice(0, 10), rates };
}

/** All USD-based rates. Never throws — falls back to the last good value, then
 *  to a hardcoded table. */
export async function fxRates(): Promise<FxRates> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v;
  // collapse concurrent callers onto one request
  inflight ??= load()
    .then((v) => {
      cache = { at: Date.now(), v };
      return v;
    })
    .catch(() => cache?.v ?? FALLBACK)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Back-compat single-rate helper. */
export async function usdToAud(): Promise<number> {
  return (await fxRates()).rates.AUD ?? FALLBACK.rates.AUD;
}
