// What counts as trying to take a deal off the platform, and when that
// becomes a person's business.
//
// Pure, and away from the database, like the dispute and rating rules: this
// decides whether a member lands in front of Trust and safety, and that
// argument should be readable in one screen.
//
// What the masking cannot do is the other half of this and belongs on every
// screen that shows these numbers. It catches the common shapes — digits
// however they are spaced, numbers written as words, emails with "(at)",
// a number split over several messages. It does not catch a photograph of a
// handwritten number, or "same name as here on insta". A count of zero means
// nothing was caught, not that nothing was tried.

/** Tags from `censor` / `weigh` that are a contact DETAIL — something that
 *  was, or would have been, removed from the text. */
const CONTACT = new Set(["phone", "email", "link", "split-contact"]);

/** Tags that are recorded because they are an invitation, but are not a
 *  detail on their own. Naming Telegram is not the same act as posting a
 *  number, and must not push anyone into a review by itself. */
const INVITATION = new Set(["off-platform", "handle", "mail-provider"]);

export function classifyFlags(flags: readonly string[] | null | undefined): {
  record: boolean;
  contact: boolean;
} {
  const list = flags ?? [];
  const contact = list.some((f) => CONTACT.has(f));
  const record = contact || list.some((f) => INVITATION.has(f));
  return { record, contact };
}

/** How far back the automatic review looks. A month: long enough that three
 *  attempts spread over a fortnight still add up, short enough that one slip
 *  a year ago does not count against someone forever. */
export const CONTACT_REVIEW_WINDOW_DAYS = 30;

/**
 * Should a member review open now?
 *
 * A review, never a strike. A strike in this console is a decision a person
 * took on a conduct case (see `members.store.ts`); a masking rule firing is
 * evidence for somebody to look at, not a finding. `limit` 0 means the
 * automatic review is off — a threshold of zero would otherwise open a
 * review for everyone who has ever typed a digit.
 */
export function reviewDue(a: { contactAttempts: number; limit: number; open: boolean }): boolean {
  if (a.open) return false;
  if (!(a.limit > 0)) return false;
  return a.contactAttempts >= a.limit;
}
