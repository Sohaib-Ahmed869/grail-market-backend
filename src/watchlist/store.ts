import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// Cards someone is following but does not own.
//
// The collection answers "what am I holding"; this answers "what am I waiting
// for". They look similar and are not: a watchlist row has no purchase price,
// no quantity and no grade of its own until the watcher picks one, and its
// whole reason to exist is the alert attached to it.
//
// An alert is a rule about movement, not a price target. "Tell me if it moves
// 10%" survives the card being worth $12 or $12,000; "tell me when it hits
// $400" is wrong the moment the market re-rates and has to be re-set by hand.

export const WATCHLIST_SCHEMA = `
CREATE TABLE IF NOT EXISTS watchlist (
  watch_id    text PRIMARY KEY,
  user_id     text NOT NULL,
  catalog_id  text,
  card_name   text NOT NULL,
  set_name    text,
  card_number text,
  image_url   text,
  grader      text,
  grade       text,
  -- the rule: fire when the value moves this far, in this direction
  alert_pct   numeric,
  alert_dir   text NOT NULL DEFAULT 'any',   -- any | up | down
  -- what the price was when we last told them, so the next alert measures
  -- from the last thing they saw rather than from the day they added it
  baseline    numeric,
  baseline_at timestamptz,
  last_price  numeric,
  checked_at  timestamptz,
  alerted_at  timestamptz,
  added_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watchlist_user ON watchlist (user_id, added_at DESC);
CREATE INDEX IF NOT EXISTS watchlist_card ON watchlist (catalog_id);
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_once
  ON watchlist (user_id, catalog_id, coalesce(grader,''), coalesce(grade,''));
`;

export async function initWatchlist(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(WATCHLIST_SCHEMA);
}

export type Watch = Record<string, any>;

export async function listWatches(userId: string): Promise<Watch[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    "select * from watchlist where user_id = $1 order by added_at desc", [userId],
  );
  return r.rows;
}

export async function addWatch(w: {
  userId: string; catalogId?: string | null; cardName: string;
  setName?: string | null; cardNumber?: string | null; imageUrl?: string | null;
  grader?: string | null; grade?: string | null;
  alertPct?: number | null; alertDir?: string | null;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `w_${randomUUID().slice(0, 12)}`;
  const r = await pool.query(
    `insert into watchlist
       (watch_id, user_id, catalog_id, card_name, set_name, card_number,
        image_url, grader, grade, alert_pct, alert_dir)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (user_id, catalog_id, coalesce(grader,''), coalesce(grade,''))
       do update set alert_pct = excluded.alert_pct, alert_dir = excluded.alert_dir
     returning watch_id`,
    [id, w.userId, w.catalogId ?? null, w.cardName, w.setName ?? null,
     w.cardNumber ?? null, w.imageUrl ?? null, w.grader ?? null, w.grade ?? null,
     w.alertPct ?? 10, w.alertDir ?? "any"],
  );
  return r.rows[0]?.watch_id ?? id;
}

export async function removeWatch(watchId: string, userId: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    "delete from watchlist where watch_id = $1 and user_id = $2", [watchId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function setAlert(
  watchId: string, userId: string, pct: number | null, dir: string,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update watchlist set alert_pct = $3, alert_dir = $4
      where watch_id = $1 and user_id = $2`,
    [watchId, userId, pct, ["any", "up", "down"].includes(dir) ? dir : "any"],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Record what a card is worth now, and say whether that crosses the rule.
 *
 *  The baseline moves only when an alert fires. Measuring from the day the
 *  card was added would mean one 10% climb alerts forever; measuring from
 *  yesterday would miss a slow drift that adds up to 30% over a fortnight.
 *  Measuring from the last thing the watcher was told is the honest middle. */
export type Fired = {
  watchId: string; userId: string; cardName: string;
  grader: string | null; grade: string | null;
  from: number; to: number; pct: number;
};

export async function recordPrice(
  watchId: string, price: number,
): Promise<Fired | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query("select * from watchlist where watch_id = $1", [watchId]);
  const w = r.rows[0];
  if (!w) return null;

  const baseline = w.baseline == null ? null : Number(w.baseline);
  const pct = w.alert_pct == null ? null : Number(w.alert_pct);

  // first sighting: set the baseline, tell nobody
  if (baseline == null || baseline <= 0) {
    await pool.query(
      `update watchlist set baseline = $2, baseline_at = now(),
                            last_price = $2, checked_at = now()
        where watch_id = $1`, [watchId, price]);
    return null;
  }

  const move = ((price - baseline) / baseline) * 100;
  const dirOk =
    w.alert_dir === "up" ? move > 0 : w.alert_dir === "down" ? move < 0 : true;
  const fires = pct != null && dirOk && Math.abs(move) >= pct;

  await pool.query(
    `update watchlist set last_price = $2, checked_at = now()
       ${fires ? ", baseline = $2, baseline_at = now(), alerted_at = now()" : ""}
      where watch_id = $1`, [watchId, price]);

  if (!fires) return null;
  return {
    watchId, userId: w.user_id, cardName: w.card_name,
    grader: w.grader, grade: w.grade,
    from: baseline, to: price, pct: move,
  };
}

/** Everything being watched, deduplicated by the card it points at, so the
 *  price for a card followed by fifty people is fetched once. */
export async function watchedCards(): Promise<Watch[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select catalog_id, card_name, set_name, card_number, grader, grade,
            array_agg(watch_id) as watch_ids
       from watchlist
      where alert_pct is not null
      group by catalog_id, card_name, set_name, card_number, grader, grade`,
  );
  return r.rows;
}
