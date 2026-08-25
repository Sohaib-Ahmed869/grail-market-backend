import type { Identification } from "@grailcard/shared";
import { bestAgainst } from "./similarity.js";
import type { CatalogMatch } from "./othergames.js";

// apitcg.com: catalogs for Union Arena, Dragon Ball Fusion World, Gundam,
// Riftbound and more. FREE key (signup, no card). Dormant until
// APITCG_API_KEY is set in apps/api/.env.

const GAMES: { slug: string; game: string }[] = [
  { slug: "union-arena", game: "unionarena" },
  { slug: "dragon-ball-fusion", game: "dragonball" },
  { slug: "gundam", game: "gundam" },
  { slug: "riftbound", game: "riftbound" },
];

const MIN_SCORE = 0.6;

export async function identifyApiTcg(names: string[]): Promise<CatalogMatch | null> {
  const key = process.env.APITCG_API_KEY;
  if (!key || names.length === 0) return null;

  for (const { slug, game } of GAMES) {
    try {
      const res = await fetch(
        `https://apitcg.com/api/${slug}/cards?name=${encodeURIComponent(names[0])}&limit=20`,
        { headers: { "x-api-key": key }, signal: AbortSignal.timeout(7000) },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as any;
      const cards = (body?.data ?? []) as any[];
      let best: { card: any; score: number; name: string } | null = null;
      for (const card of cards) {
        const m = bestAgainst(names, card.name as string);
        if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
      }
      if (best && best.score >= MIN_SCORE) {
        const c = best.card;
        const identification: Identification = {
          cardId: `apitcg-${slug}-${c.id ?? c.code ?? ""}`,
          name: c.name,
          setId: c.set?.id ?? "",
          setName: c.set?.name ?? slug,
          localId: String(c.code ?? c.id ?? ""),
          rarity: c.rarity ?? null,
          imageUrl: c.images?.large ?? c.images?.small ?? null,
          matchScore: Math.min(best.score, 1),
          ocrName: best.name,
          game,
        };
        return { identification, valuation: null };
      }
    } catch {
      /* best-effort per game */
    }
  }
  return null;
}
