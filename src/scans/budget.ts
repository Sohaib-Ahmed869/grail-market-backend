import { quotaStatus, CREDITS_PER_LOOKUP } from "./gradedprices.js";
import { monthStart, usedSince, usedToday } from "./usage.js";
import { storeStats } from "../cards.store.js";

// "How many more cards can this system actually scan today?"
//
// A scan touches several metered providers, so the answer is the WORST of
// them, not the sum. Each provider below declares what one scan costs it and
// what its allowance is; the binding constraint becomes the headline number.
//
// Where a provider reports its own budget (PPT sends x-ratelimit-* on every
// response) we trust that. Where it does not (Gemini's free allowance is
// account-specific and unpublished; JustTCG sends no headers at all) we count
// our own calls and compare against a configured ceiling. Those are labelled
// `reported: false` so the UI never presents a local assumption as fact.

export type ProviderBudget = {
  id: string;
  label: string;
  /** what this provider supplies to a scan */
  role: string;
  unit: "credits" | "requests";
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** units one scan of a NOT-yet-cached card costs this provider */
  costPerScan: number;
  scansLeft: number | null;
  /** true when the numbers come from the provider, false when measured locally */
  reported: boolean;
  /** false => not configured, or does not gate scanning */
  gating: boolean;
  note?: string;
  period: "day" | "month";
};

export type ScanBudget = {
  scansLeft: number | null;
  scansPerDay: number | null;
  /** which provider is the binding constraint right now */
  limitedBy: string | null;
  /** cards already bought and stored — these never cost a credit again */
  store: { configured: boolean; online: boolean; cards: number | null; withGraded: number | null };
  resetsAt: string | null;
  cachedCards: number;
  providers: ProviderBudget[];
};

// Gemini's free-tier RPD is account-specific and not exposed by the API, so it
// is configurable. Default is deliberately conservative; set GEMINI_DAILY_RPD
// to the number AI Studio shows for the account.
const GEMINI_DAILY_RPD = Number(process.env.GEMINI_DAILY_RPD ?? 200);
// worst case per scan: one identify call + one grounded web-price fallback
const GEMINI_PER_SCAN = 2;

// JustTCG free tier is documented at 1,000 requests/month.
const JUSTTCG_MONTHLY = Number(process.env.JUSTTCG_MONTHLY ?? 1000);
const JUSTTCG_PER_SCAN = 1;

function scansFrom(remaining: number | null, cost: number): number | null {
  if (remaining == null || cost <= 0) return null;
  return Math.max(0, Math.floor(remaining / cost));
}

export async function scanBudget(): Promise<ScanBudget> {
  const ppt = quotaStatus();
  const providers: ProviderBudget[] = [];

  // ---- PokemonPriceTracker: graded (PSA) sold comps. The money number. ----
  const pptRemaining = ppt.configured ? ppt.totalRemaining : null;
  providers.push({
    id: "ppt",
    label: "PokemonPriceTracker",
    role: "Graded PSA prices",
    unit: "credits",
    used:
      ppt.dailyLimit != null && pptRemaining != null ? ppt.dailyLimit - pptRemaining : null,
    limit: ppt.dailyLimit,
    remaining: pptRemaining,
    costPerScan: CREDITS_PER_LOOKUP,
    scansLeft: ppt.lockedOut ? 0 : scansFrom(pptRemaining, CREDITS_PER_LOOKUP),
    reported: true,
    gating: ppt.configured,
    note: ppt.configured
      ? undefined
      : "no API key set — graded prices unavailable",
    period: "day",
  });

  // ---- Gemini: LLM identification + last-resort web pricing ----
  const gConfigured = Boolean(process.env.GEMINI_API_KEY);
  const gUsed = usedToday("gemini");
  const gRemaining = gConfigured ? Math.max(0, GEMINI_DAILY_RPD - gUsed) : null;
  providers.push({
    id: "gemini",
    label: "Gemini",
    role: "Card identification",
    unit: "requests",
    used: gUsed,
    limit: gConfigured ? GEMINI_DAILY_RPD : null,
    remaining: gRemaining,
    costPerScan: GEMINI_PER_SCAN,
    scansLeft: scansFrom(gRemaining, GEMINI_PER_SCAN),
    reported: false,
    gating: gConfigured,
    note: "daily cap is configured locally, not reported by Google — set GEMINI_DAILY_RPD to match AI Studio",
    period: "day",
  });

  // ---- JustTCG: raw/ungraded prices, monthly allowance ----
  const jConfigured = Boolean(process.env.JUSTTCG_API_KEY);
  const jUsed = usedSince("justtcg", monthStart());
  const jRemaining = jConfigured ? Math.max(0, JUSTTCG_MONTHLY - jUsed) : null;
  providers.push({
    id: "justtcg",
    label: "JustTCG",
    role: "Raw market prices",
    unit: "requests",
    used: jUsed,
    limit: jConfigured ? JUSTTCG_MONTHLY : null,
    remaining: jRemaining,
    costPerScan: JUSTTCG_PER_SCAN,
    scansLeft: scansFrom(jRemaining, JUSTTCG_PER_SCAN),
    reported: false,
    gating: jConfigured,
    note: "monthly allowance",
    period: "month",
  });

  // ---- CardGrader: graded backup, billed per call rather than a daily cap ----
  providers.push({
    id: "cardgrader",
    label: "CardGrader",
    role: "Graded price backup",
    unit: "requests",
    used: usedToday("cardgrader"),
    limit: null,
    remaining: null,
    costPerScan: 1,
    scansLeft: null,
    reported: false,
    gating: false,
    note: "pay-per-call, no daily cap",
    period: "day",
  });

  // the binding constraint across everything that actually gates a scan
  const gating = providers.filter((p) => p.gating && p.scansLeft != null);
  let scansLeft: number | null = null;
  let limitedBy: string | null = null;
  for (const p of gating) {
    if (scansLeft == null || (p.scansLeft as number) < scansLeft) {
      scansLeft = p.scansLeft as number;
      limitedBy = p.label;
    }
  }

  // the same calculation at a full allowance — the denominator for "N / M"
  let scansPerDay: number | null = null;
  for (const p of gating) {
    if (p.limit == null) continue;
    const full = Math.floor(p.limit / p.costPerScan);
    if (scansPerDay == null || full < scansPerDay) scansPerDay = full;
  }

  return {
    scansLeft,
    scansPerDay,
    limitedBy,
    store: await storeStats(),
    resetsAt: ppt.resetsAt,
    cachedCards: ppt.cachedCards,
    providers,
  };
}
