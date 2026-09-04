/**
 * A worked audit log, for looking at the page.
 *
 *   npx tsx scripts/seed-audit.mts
 *
 * The log fills on its own as decisions are taken in the console, which is the
 * right way round but means an untouched database shows an empty page and
 * there is nothing to judge the layout against. These are the entries a normal
 * fortnight leaves behind.
 *
 * Chosen to cover what the page is laid out around rather than to look busy:
 * every one of the eight areas appears, both weights appear, several entries
 * carry the reason recorded at the time and several deliberately do not (an
 * approval needs no reason; a rejection does), and more than one operator is
 * present so the operator filter has something to filter. The consequential
 * ones are spread through rather than bunched, because a log where the red
 * badges are all together does not show whether they can be picked out.
 *
 * Written through `writeAudit`, not with an INSERT of its own — the table is
 * append-only and there should be exactly one thing in the codebase that
 * writes to it.
 *
 * Re-running it adds another set rather than editing the first. That is what
 * an append-only log does.
 *
 * `--replace` first deletes any entry whose actor is not on the console team.
 * That is narrow on purpose: a revoked colleague's entries must survive, which
 * is the whole reason the actor name is denormalised onto the row — so the
 * only thing it can catch is an actor nobody was, which is what a previous
 * run of this script with invented names left behind. Real decisions are
 * never touched, because a real decision was taken by somebody who had an
 * account when they took it.
 */
import { loadEnvFile } from "../src/env.js";
/* A type-only import, so it is erased and does not load the module before
   `loadEnvFile()` has run — the store reads DATABASE_URL at import time. */
import type { AuditArea } from "../src/admin/audit.store.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { initAdmin } = await import("../src/admin/store.js");
const { writeAudit } = await import("../src/admin/audit.store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initAdmin();
const pool = storePool()!;

/**
 * Who to file these under.
 *
 * The names were written into this file — "Ayna Sulaiman" and two others — on
 * a database where nobody is called that, so the log named people who did not
 * exist and the operator filter offered them. It reads the real console team
 * instead, and refuses to run rather than invent one.
 */
const staff = await pool.query(
  "select name from users where role <> 'member' order by role, name",
);
const ACTORS: string[] = staff.rows.map((r: any) => r.name);
if (ACTORS.length === 0) {
  console.error(
    "Nobody holds a console role, so there is nobody to file these under. " +
      "Run scripts/seed-staff.mts, or set ADMIN_OWNERS and start the API once.",
  );
  process.exit(1);
}
/** Spread the entries over whoever is actually on the team. */
const actor = (i: number) => ACTORS[i % ACTORS.length];

type Entry = {
  /** Hours before now. The list is written oldest first so the page's
   *  newest-first order is the reverse of the way this reads. */
  hoursAgo: number;
  actor: string;
  area: AuditArea;
  action: string;
  target: string;
  detail?: string;
  weight?: "high" | "normal";
};

const ENTRIES: Entry[] = [
  /* ---------------------------------------------------------- two weeks ago */
  {
    hoursAgo: 331,
    actor: actor(0),
    area: "staff",
    action: "Granted the Support · Tier 1 role",
    target: "an outsourced support account",
    detail: "Outsourced desk. Their own queue only.",
    weight: "high",
  },
  {
    hoursAgo: 322,
    actor: actor(1),
    area: "settings",
    action: "Changed a setting",
    target: "Grail-tier review floor",
    detail: "A$4,000 → A$5,000. Too much was landing in the grail queue to review properly.",
  },

  /* ------------------------------------------------------------- last week */
  {
    hoursAgo: 214,
    actor: actor(2),
    area: "pricing",
    action: "Excluded a sale as an outlier",
    target: "1999 Base Set Charizard · PSA 10",
    detail: "149% above the median and the listing title carried 'lot of 3'. Not a single-card sale.",
  },
  {
    hoursAgo: 208,
    actor: actor(3),
    area: "listing",
    action: "Approved a listing",
    target: "2016 Evolutions Charizard · PSA 9",
  },
  {
    hoursAgo: 201,
    actor: actor(4),
    area: "listing",
    action: "Rejected a listing",
    target: "Dark Magician Girl · CGC 9.5",
    detail: "Four angles supplied, ten required. The slab edges and all four corners are missing.",
    weight: "high",
  },
  {
    hoursAgo: 190,
    actor: actor(5),
    area: "billing",
    action: "Comped a boost",
    target: "@duelistdepot",
    detail: "A$12 not charged. Their listing was pulled by mistake and the boost ran on nothing.",
    weight: "high",
  },

  /* -------------------------------------------------------- the last few days */
  {
    hoursAgo: 122,
    actor: actor(6),
    area: "member",
    action: "Restricted an account",
    target: "@duelistdepot",
    detail: "Two separate reports of coordinated bidding on their own listings. Restricted pending the case.",
    weight: "high",
  },
  {
    hoursAgo: 119,
    actor: actor(7),
    area: "conduct",
    action: "Recorded a formal warning",
    target: "@galar_pc, raised by @vault_flipper",
    detail: "Off-platform contact, first offence, admitted when asked. A second one restricts the account.",
    weight: "high",
  },
  {
    hoursAgo: 96,
    actor: actor(8),
    area: "support",
    action: "Replied to a ticket",
    target: "Where is my payout?",
  },
  {
    hoursAgo: 94,
    actor: actor(9),
    area: "support",
    action: "Added an internal note to a ticket",
    target: "Scan says PSA 9, slab says PSA 10",
    detail: "Photographs are of a different slab from the cert on the listing. Handing to Tier 2.",
  },
  {
    hoursAgo: 88,
    actor: actor(10),
    area: "listing",
    action: "Withdrew a listing",
    target: "1952 Topps Mickey Mantle · SGC 84",
    detail: "Suspected resealed slab. The seller's other listings are paused while this is checked.",
    weight: "high",
  },
  {
    hoursAgo: 74,
    actor: actor(11),
    area: "billing",
    action: "Comped 1 month of a plan",
    target: "collector · @cardsbyleah",
    detail: "Charged twice in March through our own error. One month back rather than a refund.",
    weight: "high",
  },

  /* ------------------------------------------------------------- yesterday */
  {
    hoursAgo: 30,
    actor: actor(12),
    area: "conduct",
    action: "Closed a case with no action",
    target: "@vault_flipper, who raised it against @galar_pc",
    detail: "Both accounts supplied tracking. The parcel was late, not missing. Nothing to answer.",
  },
  {
    hoursAgo: 27,
    actor: actor(13),
    area: "listing",
    action: "Requested more from the seller",
    target: "Blue-Eyes White Dragon · BGS 9",
    detail: "A straight-on photograph of the subgrade block, and the original invoice.",
    weight: "high",
  },
  {
    hoursAgo: 22,
    actor: actor(14),
    area: "billing",
    action: "Changed a plan price at Stripe",
    target: "Collector",
    detail:
      "12.00 AUD a month. A new price was created; existing subscribers keep the one they signed up on.",
    weight: "high",
  },

  /* ----------------------------------------------------------------- today */
  {
    hoursAgo: 9,
    actor: actor(15),
    area: "support",
    action: "Replied to a ticket",
    target: "Can I change the grader on a listing?",
  },
  {
    hoursAgo: 6,
    actor: actor(16),
    area: "settings",
    action: "Sent an announcement",
    target: "Card scanning is slow this morning",
    detail: "banner · everyone · 5218 accounts",
    weight: "high",
  },
  {
    hoursAgo: 4,
    actor: actor(17),
    area: "listing",
    action: "Approved a listing",
    target: "2003 Aquapolis Lugia · PSA 8",
  },
  {
    hoursAgo: 2,
    actor: actor(18),
    area: "member",
    action: "Put an account back in good standing",
    target: "@duelistdepot",
    detail: "Case closed with a warning rather than a restriction. Access returned.",
    weight: "high",
  },
  {
    hoursAgo: 1,
    actor: actor(19),
    area: "pricing",
    action: "Put an excluded sale back into the figure",
    target: "2016 Evolutions Charizard · PSA 9",
    detail: "Checked against the source listing: a single card, correctly priced. Excluded in error.",
  },
];

/* `writeAudit` stamps `at` with now(), which would pile every one of these on
   the same minute and make the newest-first order meaningless. The timestamp
   is corrected afterwards, by id, which is the one thing this script does that
   the console cannot — and the only reason it touches the table directly. */
if (process.argv.includes("--replace")) {
  const gone = await pool.query(
    "delete from admin_audit where actor <> all($1) returning entry_id",
    [ACTORS],
  );
  console.log(`Removed ${gone.rowCount} entr${gone.rowCount === 1 ? "y" : "ies"} written by nobody.
`);
}

let written = 0;
for (const e of ENTRIES) {
  const id = await writeAudit({
    actor: e.actor,
    area: e.area,
    action: e.action,
    target: e.target,
    detail: e.detail ?? null,
    weight: e.weight ?? "normal",
  });
  if (!id) {
    console.error(`  ! ${e.action} — not written`);
    continue;
  }
  await pool.query(
    "update admin_audit set at = now() - ($2 || ' hours')::interval where entry_id = $1",
    [id, String(e.hoursAgo)],
  );
  written += 1;
  console.log(`  ${e.weight === "high" ? "!" : "·"} ${e.actor} — ${e.action}`);
}

const total = await pool.query("select count(*)::int n from admin_audit");
console.log(`\n${written} entries written. The log now holds ${total.rows[0].n}.`);
process.exit(0);
