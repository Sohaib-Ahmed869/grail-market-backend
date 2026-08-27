import { fetchGradedPrices } from "../scans/gradedprices.js";
import { quotaStatus, CREDITS_PER_INGEST_LOOKUP } from "../scans/gradedprices.js";
import { graderTier } from "../scans/graders.js";
import {
  refreshCandidates,
  writeGradePrices,
  writeRawPrice,
  notePriceAttempt,
  type RefreshCandidate,
} from "../cards.store.js";

// Batch price refresh.
//
// The thing this exists to change: pricing used to happen on the request path,
// so the bill scaled with TRAFFIC. Every scan of an uncached card bought a
// lookup, the same popular card was re-bought by every instance that had not
// seen it, and a busy day cost more than a quiet one for identical data.
//
// Prices are a property of the CATALOGUE, not of who happens to be looking.
// The catalogue is roughly fixed and the traffic is not, so the refresh runs on
// a schedule against a work list and the scan path just reads what it finds.
// A hundred scans a day and a million scans a day now cost the same.
//
// Tiering does the rest. A card with hundreds of recent sales genuinely moves
// week to week and lots of people ask about it; a common with three lifetime
// sales does not. Re-pricing both daily is how a $10 plan turns into a $99 one
// for no gain — so the busy cards get a daily figure and the tail gets a
// monthly one. See refreshCandidates() for the tier rules.

export type IngestResult = {
  considered: number;
  priced: number;
  missed: number;
  failed: number;
  creditsSpent: number;
  creditsLeft: number | null;
  stoppedBecause: "budget" | "worklist" | "quota-locked" | "not-configured";
  tiers: Record<string, number>;
};

/** Leave this much of the daily allowance for live scans of cards the job has
 *  not reached yet. The job is a background nicety; a scan is a person
 *  waiting. */
const RESERVE_FRACTION = Number(process.env.INGEST_RESERVE_FRACTION ?? 0.25);

export async function ingestPrices(opts?: {
  /** hard ceiling on lookups this run, over and above the credit budget */
  limit?: number;
  /** report what it would do without spending anything */
  dryRun?: boolean;
}): Promise<IngestResult> {
  const limit = opts?.limit ?? Number(process.env.INGEST_BATCH_LIMIT ?? 500);
  const dryRun = opts?.dryRun ?? false;
  const result: IngestResult = {
    considered: 0, priced: 0, missed: 0, failed: 0,
    creditsSpent: 0, creditsLeft: null,
    stoppedBecause: "worklist",
    tiers: {},
  };

  const quota = quotaStatus();
  if (!quota.configured) {
    result.stoppedBecause = "not-configured";
    console.warn("[ingest] PPT_API_KEY not set — nothing to refresh from");
    return result;
  }
  if (quota.lockedOut) {
    result.stoppedBecause = "quota-locked";
    console.warn("[ingest] provider quota is exhausted — try again after reset");
    return result;
  }

  // Spend against what the provider says is left, not against a guess. If we
  // have never seen a response there is no number to reserve against, so take
  // the batch limit as the only ceiling and let the 429 breaker stop us.
  const total = quota.totalRemaining;
  const spendable =
    total == null ? Infinity : Math.max(0, Math.floor(total * (1 - RESERVE_FRACTION)));
  result.creditsLeft = total;

  const work = await refreshCandidates(limit);
  result.considered = work.length;
  if (work.length === 0) {
    console.log("[ingest] nothing stale — catalogue is current");
    return result;
  }

  for (const c of work) {
    result.tiers[c.tier] = (result.tiers[c.tier] ?? 0) + 1;
  }
  console.log(
    `[ingest] ${work.length} cards to refresh ` +
      `(${Object.entries(result.tiers).map(([t, n]) => `${n} ${t}`).join(", ")}), ` +
      `budget ${spendable === Infinity ? "unknown" : spendable} credits ` +
      `@ ${CREDITS_PER_INGEST_LOOKUP}/card`,
  );

  if (dryRun) {
    for (const c of work.slice(0, 20)) console.log(`[ingest]   ${describe(c)}`);
    if (work.length > 20) console.log(`[ingest]   … and ${work.length - 20} more`);
    return result;
  }

  for (const c of work) {
    if (result.creditsSpent + CREDITS_PER_INGEST_LOOKUP > spendable) {
      result.stoppedBecause = "budget";
      console.log(`[ingest] budget reached after ${result.priced + result.missed} cards`);
      break;
    }

    try {
      // force: the point of the job is to replace what we already hold
      const ppt = await fetchGradedPrices(c.name, c.cardNumber, c.setName, { force: true });
      result.creditsSpent += CREDITS_PER_INGEST_LOOKUP;

      const byGrader = ppt.byGrader ?? {};
      const rows = Object.entries(byGrader).flatMap(([grader, grades]) =>
        Object.entries(grades).map(([grade, pt]) => ({
          grader,
          grade: Number(grade),
          tier: graderTier(grader),
          price: pt.price ?? null,
          sampleSize: pt.count ?? null,
          confidence: pt.confidence ?? null,
          method: pt.method ?? null,
          low: pt.low ?? null,
          high: pt.high ?? null,
          median: pt.median ?? null,
          source: "pokemonpricetracker",
        })),
      );

      if (rows.length > 0) {
        await writeGradePrices(c.catalogId, rows);
        result.priced++;
      } else {
        // A card the provider genuinely has no sales for — a Japanese-only
        // set, or one too new for English comps. Not a failure. But it writes
        // no grade_prices row, so without recording the ATTEMPT it stays
        // "never priced", sorts to the top of the work list, and gets bought
        // again on every run.
        result.missed++;
      }
      await notePriceAttempt(c.catalogId, rows.length > 0);
      if (ppt.rawUsd != null) await writeRawPrice(c.catalogId, ppt.rawUsd);
    } catch (err) {
      result.failed++;
      console.warn(`[ingest] ${c.catalogId} failed: ${(err as Error).message}`);
    }
  }

  const after = quotaStatus();
  result.creditsLeft = after.totalRemaining;
  console.log(
    `[ingest] done — ${result.priced} priced, ${result.missed} with no sales, ` +
      `${result.failed} failed, ~${result.creditsSpent} credits spent` +
      (after.totalRemaining != null ? `, ${after.totalRemaining} left` : ""),
  );
  return result;
}

function describe(c: RefreshCandidate): string {
  const age = c.ageHours == null ? "never priced" : `${Math.round(c.ageHours)}h old`;
  return `${c.tier.padEnd(4)} ${c.catalogId.padEnd(16)} ${c.name} — ${age}, seen ${c.seenCount}×`;
}
