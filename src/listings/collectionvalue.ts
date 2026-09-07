/** What one held card is worth today, or why we are not saying.
 *
 *  Its own module so it can be tested without a database and a network: the
 *  bug it exists to stop was a one-line ternary inside a route handler, which
 *  is exactly the shape of thing nothing ever covers.
 *
 *  Invariant 1 of this project is that a grade belongs to (card + company) and
 *  there is no grade-only lookup. The inverse is just as wrong and is what
 *  shipped: a NO-grade lookup answered with the ungraded price. A BGS
 *  Celebrations Palkia was valued at the 23 cents a loose copy trades for,
 *  under a badge reading BECKETT, because `grader && grade` fell through to
 *  raw the moment the grade was missing.
 *
 *  A slab is a different product from the card inside it. Not knowing which
 *  rung it sits on makes it unpriceable, not ungraded.
 */

export type GradedLookupLike = {
  rawUsd?: number | null;
  byGrader?: Record<string, Record<string, { price?: number | null }>> | null;
} | null;

/** Why a card has no figure beside it.
 *
 *  Three reasons, kept apart because only one of them is the owner's to fix
 *  and a screen that cannot tell them apart can only shrug.
 *
 *    grade  we know the company, not the rung. Editing the entry fixes it.
 *    sales  we know both and have no sale at that rung for this card.
 *    price  we have no price for this card at all.
 */
export type Unpriced = "grade" | "sales" | "price";

const num = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

export function valueOfEntry(
  entry: { grader?: string | null; grade?: string | number | null },
  priced: GradedLookupLike,
): { value: number | null; unpriced: Unpriced | null } {
  // A lookup that failed is a blank with a reason, never a zero. Zero is a
  // claim about a card and every one of these is a claim about us.
  if (!priced) return { value: null, unpriced: "price" };

  const grader = String(entry.grader ?? "").trim().toUpperCase();
  // The add form sends "" for a box the owner cleared, and "" is not a grade.
  // Reading it as one is how a slab became a raw card.
  const grade = String(entry.grade ?? "").trim();

  if (grader) {
    if (!grade) return { value: null, unpriced: "grade" };
    // Its own company and its own rung. Never a neighbouring grade, never
    // another company's ladder, at any sample size — those are invariants 1
    // and 2 and there is no fallback here on purpose.
    const price = num(priced.byGrader?.[grader]?.[grade]?.price);
    return price != null ? { value: price, unpriced: null } : { value: null, unpriced: "sales" };
  }

  const raw = num(priced.rawUsd);
  return raw != null ? { value: raw, unpriced: null } : { value: null, unpriced: "price" };
}
