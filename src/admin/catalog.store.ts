import { storePool } from "../cards.store.js";
import { asEdition, asFinish, asLanguage } from "../catalog/sku.js";

// Admin CRUD over the catalogue - GM001-26.
//
// Every other admin surface here reads. This one WRITES to the thing every
// price is keyed on, so it is deliberately the most conservative of them:
//
//   - Its own capability, `catalog.write`, granted to owner alone. Editing a
//     card's number or set changes what every price, listing and collection
//     row about it means, which is a different kind of power from approving
//     one listing.
//   - The SKU axes go through the same normalisers the rest of the system
//     uses, so a console cannot introduce a finish value that no code
//     recognises. An unrecognised value is rejected rather than stored.
//   - Nothing is deleted while anything references it. A catalogue row with
//     listings or collection entries pointing at it is not spare - removing it
//     would leave somebody's card pointing at nothing.

export type CatalogCard = {
  catalogId: string;
  game: string | null;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  language: string | null;
  edition: string | null;
  finish: string | null;
  rawUsd: number | null;
  seenCount: number;
  lastSeenAt: string | null;
};

const shape = (r: any): CatalogCard => ({
  catalogId: r.catalog_id,
  game: r.game ?? null,
  name: r.name,
  setName: r.set_name ?? null,
  cardNumber: r.card_number ?? null,
  language: r.language ?? null,
  edition: r.edition ?? null,
  finish: r.finish ?? null,
  rawUsd: r.raw_usd == null ? null : Number(r.raw_usd),
  seenCount: Number(r.seen_count ?? 0),
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
});

export async function searchCatalog(q: {
  text?: string | null; game?: string | null; limit?: number; offset?: number;
}): Promise<{ cards: CatalogCard[]; total: number }> {
  const pool = storePool();
  if (!pool) return { cards: [], total: 0 };
  const limit = Math.min(q.limit ?? 50, 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const text = q.text?.trim() || null;

  const where: string[] = [];
  const args: unknown[] = [];
  if (text) {
    args.push(`%${text}%`);
    // Name, number or id - a moderator looking a card up has one of the three,
    // and which one it is should not be their problem.
    where.push(`(name ILIKE $${args.length} OR card_number ILIKE $${args.length} OR catalog_id ILIKE $${args.length})`);
  }
  if (q.game) {
    args.push(q.game);
    where.push(`game = $${args.length}`);
  }
  const clause = where.length ? `where ${where.join(" and ")}` : "";

  const [rows, count] = await Promise.all([
    pool.query(
      `select * from catalog_cards ${clause}
        order by last_seen_at desc nulls last limit ${limit} offset ${offset}`,
      args,
    ),
    pool.query(`select count(*)::int n from catalog_cards ${clause}`, args),
  ]);
  return { cards: rows.rows.map(shape), total: count.rows[0]?.n ?? 0 };
}

export async function getCatalogCard(id: string): Promise<CatalogCard | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query("select * from catalog_cards where catalog_id = $1", [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

export type WriteResult =
  | { ok: true; card: CatalogCard }
  | { ok: false; why: "exists" | "not-found" | "invalid" | "in-use" | "no-store"; message: string };

/** The SKU axes, normalised or refused.
 *
 *  Returning an error rather than silently nulling an unrecognised value: a
 *  console that quietly drops what an operator typed teaches them the field
 *  does not work. */
function axes(b: { language?: unknown; edition?: unknown; finish?: unknown }):
  | { ok: true; language: string | null; edition: string | null; finish: string | null }
  | { ok: false; message: string } {
  const given = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";
  const language = given(b.language) ? asLanguage(b.language) : null;
  const edition = given(b.edition) ? asEdition(b.edition) : null;
  const finish = given(b.finish) ? asFinish(b.finish) : null;
  if (given(b.language) && !language) return { ok: false, message: `"${b.language}" is not a language we recognise.` };
  if (given(b.edition) && !edition) return { ok: false, message: `"${b.edition}" is not an edition we recognise.` };
  if (given(b.finish) && !finish) return { ok: false, message: `"${b.finish}" is not a finish we recognise.` };
  return { ok: true, language, edition, finish };
}

export async function createCatalogCard(b: {
  catalogId?: string; game?: string; name?: string; setName?: string;
  cardNumber?: string; language?: unknown; edition?: unknown; finish?: unknown;
}): Promise<WriteResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store", message: "The catalogue store is unavailable." };
  const id = String(b.catalogId ?? "").trim();
  const name = String(b.name ?? "").trim();
  if (!id || !name) {
    return { ok: false, why: "invalid", message: "A catalogue id and a name are required." };
  }
  const a = axes(b);
  if (!a.ok) return { ok: false, why: "invalid", message: a.message };

  if (await getCatalogCard(id)) {
    return { ok: false, why: "exists", message: `${id} is already in the catalogue.` };
  }
  await pool.query(
    `insert into catalog_cards
       (catalog_id, game, name, set_name, card_number, language, edition, finish)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, b.game ?? null, name, b.setName ?? null, b.cardNumber ?? null,
     a.language, a.edition, a.finish],
  );
  return { ok: true, card: (await getCatalogCard(id))! };
}

/** Edit. Only the fields actually sent are touched, so a console that renders
 *  a partial form cannot blank the rest of the row. */
export async function updateCatalogCard(id: string, b: Record<string, unknown>): Promise<WriteResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store", message: "The catalogue store is unavailable." };
  if (!(await getCatalogCard(id))) {
    return { ok: false, why: "not-found", message: `${id} is not in the catalogue.` };
  }
  const a = axes(b);
  if (!a.ok) return { ok: false, why: "invalid", message: a.message };

  const sets: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown) => {
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  };
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n) return { ok: false, why: "invalid", message: "A card cannot have an empty name." };
    put("name", n);
  }
  if (b.game !== undefined) put("game", b.game || null);
  if (b.setName !== undefined) put("set_name", b.setName || null);
  if (b.cardNumber !== undefined) put("card_number", b.cardNumber || null);
  if (b.language !== undefined) put("language", a.language);
  if (b.edition !== undefined) put("edition", a.edition);
  if (b.finish !== undefined) put("finish", a.finish);

  if (!sets.length) {
    return { ok: false, why: "invalid", message: "Nothing to change." };
  }
  args.push(id);
  await pool.query(`update catalog_cards set ${sets.join(", ")} where catalog_id = $${args.length}`, args);
  return { ok: true, card: (await getCatalogCard(id))! };
}

/** What points at this card. Checked before a delete, and worth returning on
 *  its own so a console can show why a row cannot be removed. */
export async function catalogReferences(id: string): Promise<{ listings: number; collection: number; prices: number }> {
  const pool = storePool();
  if (!pool) return { listings: 0, collection: 0, prices: 0 };
  const [l, c, p] = await Promise.all([
    pool.query("select count(*)::int n from listings where catalog_id = $1", [id]),
    pool.query("select count(*)::int n from collection where catalog_id = $1", [id]),
    pool.query("select count(*)::int n from grade_prices where catalog_id = $1", [id]),
  ]);
  return {
    listings: l.rows[0]?.n ?? 0,
    collection: c.rows[0]?.n ?? 0,
    prices: p.rows[0]?.n ?? 0,
  };
}

/** Remove a catalogue row, but never one somebody's card points at.
 *
 *  Prices do NOT block it: those are ours and rebuildable. A listing or a
 *  collection entry belongs to a person, and deleting the card underneath it
 *  leaves them holding a row that refers to nothing. */
export async function deleteCatalogCard(id: string): Promise<WriteResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store", message: "The catalogue store is unavailable." };
  const card = await getCatalogCard(id);
  if (!card) return { ok: false, why: "not-found", message: `${id} is not in the catalogue.` };

  const refs = await catalogReferences(id);
  if (refs.listings || refs.collection) {
    const bits = [
      refs.listings ? `${refs.listings} listing${refs.listings === 1 ? "" : "s"}` : null,
      refs.collection ? `${refs.collection} collection entr${refs.collection === 1 ? "y" : "ies"}` : null,
    ].filter(Boolean).join(" and ");
    return {
      ok: false,
      why: "in-use",
      message: `${bits} point at this card. Removing it would leave them referring to nothing.`,
    };
  }
  await pool.query("delete from catalog_cards where catalog_id = $1", [id]);
  return { ok: true, card };
}
