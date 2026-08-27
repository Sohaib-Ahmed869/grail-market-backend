import { quotaStatus, CREDITS_PER_LOOKUP } from "./gradedprices.js";
import { allUsedToday, monthStart, usedSince, usedToday } from "./usage.js";
import { storeStats } from "../cards.store.js";
import { justTcgQuota } from "./justtcg.js";
import { observedCostPerScan } from "./ledger.js";

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
  /** Every unit metered today, per provider, whatever spent it.
   *
   *  Distinct from scans.creditsToday, which counts only what SCANS cost. The
   *  refresh job and key checks run outside a scan and are charged to nobody,
   *  so the two disagree by design — this is the one that answers "what have
   *  we actually spent today". */
  spendToday: Record<string, number>;
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

  // What a scan has actually cost lately, where we have enough history to say.
  // Falls back to the declared assumption otherwise — see observedCostPerScan.
  const [gObserved, pObserved] = await Promise.all([
    observedCostPerScan("gemini"),
    observedCostPerScan("ppt"),
  ]);

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
    costPerScan: pObserved ?? CREDITS_PER_LOOKUP,
    scansLeft: ppt.lockedOut ? 0 : scansFrom(pptRemaining, pObserved ?? CREDITS_PER_LOOKUP),
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
    costPerScan: gObserved ?? GEMINI_PER_SCAN,
    scansLeft: scansFrom(gRemaining, gObserved ?? GEMINI_PER_SCAN),
    reported: false,
    gating: gConfigured,
    note:
      "daily cap is configured locally, not reported by Google — set GEMINI_DAILY_RPD to match AI Studio" +
      (gObserved ? `; cost/scan measured from the last 30 days, not assumed` : ""),
    period: "day",
  });

  // ---- JustTCG: raw/ungraded prices ----
  //
  // It states its own budget on every response, including the plan the key is
  // on, so use that. Counting our own calls against a hardcoded free-tier
  // ceiling showed a paid Starter Plan key as "994/1000" when it actually had
  // 9,916 of 10,000 monthly requests left. The daily cap binds first on that
  // plan, so the daily figure is the one that limits scanning.
  const jConfigured = Boolean(process.env.JUSTTCG_API_KEY);
  const jq = jConfigured ? justTcgQuota() : null;
  const jReported = Boolean(jq && (jq.dailyLimit != null || jq.monthlyLimit != null));
  // whichever allowance runs out first is the real constraint
  const jRemaining = jReported
    ? Math.min(
        ...[jq!.dailyRemaining, jq!.monthlyRemaining].filter(
          (x): x is number => x != null,
        ),
      )
    : jConfigured
      ? Math.max(0, JUSTTCG_MONTHLY - usedSince("justtcg", monthStart()))
      : null;
  const jDailyBinds =
    jReported && jq!.dailyRemaining != null &&
    (jq!.monthlyRemaining == null || jq!.dailyRemaining <= jq!.monthlyRemaining);
  providers.push({
    id: "justtcg",
    label: "JustTCG",
    role: "Raw market prices",
    unit: "requests",
    used: jReported
      ? (jDailyBinds ? jq!.dailyUsed : jq!.monthlyUsed) ?? null
      : usedSince("justtcg", monthStart()),
    limit: jReported
      ? (jDailyBinds ? jq!.dailyLimit : jq!.monthlyLimit) ?? null
      : jConfigured ? JUSTTCG_MONTHLY : null,
    remaining: jRemaining,
    costPerScan: JUSTTCG_PER_SCAN,
    scansLeft: scansFrom(jRemaining, JUSTTCG_PER_SCAN),
    reported: jReported,
    gating: jConfigured,
    note: jReported
      ? [jq!.plan, jDailyBinds ? "daily cap binds first" : "monthly allowance"]
          .filter(Boolean)
          .join(" · ")
      : "monthly allowance — assumed, no call made yet",
    period: jDailyBinds ? "day" : "month",
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

  const store = await storeStats();

  return {
    scansLeft,
    scansPerDay,
    limitedBy,
    store,
    resetsAt: ppt.resetsAt,
    // The SHARED store, not this instance's SQLite file. "Cards already
    // cached" is read as "cards that cost nothing to scan again", and the
    // local count is neither shared between instances nor durable — it
    // undercounted 21 cards as 14.
    cachedCards: store.cards ?? ppt.cachedCards,
    providers,
    spendToday: allUsedToday(),
  };
}
