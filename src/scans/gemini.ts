// LLM world-knowledge identification (Gemini free tier) — the fallback when
// OCR + catalogs fail (Japanese names, non-TCG cards, stylized fonts).
// STRICT ROLE LIMIT: the model may only NAME and DESCRIBE the card. It is
// never asked for condition, grades, or prices — those come from measurement,
// trained CV, and real market feeds only.

// primary + fallback: the free tier 503s under load, and the lite model
// usually has spare capacity when flash doesn't
import { recordUsage } from "./usage.js";
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

export type LlmIdentification = {
  name: string;
  game: string; // pokemon | mtg | yugioh | onepiece | other
  setName: string | null;
  edition: string | null;
  language: string | null;
  /** the ART/PRINTING this copy is, where the card has more than one.
   *  Identification, not valuation: which product it is, never what it costs. */
  printing: string | null;
};

const PROMPT = `Identify this trading card from the photo. Respond with JSON only:
{"name": "...", "game": "pokemon|mtg|yugioh|onepiece|lorcana|digimon|starwars|dragonball|gundam|unionarena|riftbound|sports|other", "setName": "... or null", "edition": "... or null", "language": "en|ja|other|unknown", "printing": "... or null", "confident": true|false}
Rules:
- "name" is the card's title exactly as officially known (English official name if it exists).
- "printing" names WHICH ART/VERSION of this card it is, when the same card
  number exists in several. Use the collector's usual term, e.g. "manga art",
  "alternate art", "parallel", "wanted poster SP", "full art", "reverse holo",
  "1st edition", "shadowless". Judge it from the artwork you can see. Use null
  if the card has only one printing or you cannot tell.
- If you are not reasonably sure of a field, use null (or "confident": false).
- Do NOT guess condition, grades, or monetary value. Identification only.`;

export async function identifyWithGemini(
  imageB64: string,
  mimeType = "image/jpeg",
): Promise<LlmIdentification | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    // Each model gets its own attempt, and a failure moves on to the next one.
    //
    // This used to put one 30-second timeout on the whole call and let the
    // timeout throw straight out of the loop. So when the primary model was
    // overloaded — the free tier answers 503 or simply hangs under load — the
    // fallback model was never asked at all, and the scan fell through to
    // naming the card from stray OCR text. A clear LeBron James came back as
    // "Pps" (the end of the Topps logo) that way. Asked directly, the same
    // photo timed out twice in three tries on the primary and answered fine on
    // the lite model.
    //
    // The primary gets a short leash; the lite model, which has spare capacity
    // when flash does not, gets a retry on a transient failure.
    let text: string | undefined;
    for (const [index, model] of MODELS.entries()) {
      const attempts = index === 0 ? 1 : 2;
      for (let attempt = 0; attempt < attempts && !text; attempt++) {
        recordUsage("gemini");
        let transient = true;
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: "POST",
              headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      { text: PROMPT },
                      { inline_data: { mime_type: mimeType, data: imageB64 } },
                    ],
                  },
                ],
                generationConfig: { responseMimeType: "application/json", temperature: 0 },
              }),
              signal: AbortSignal.timeout(index === 0 ? 12_000 : 20_000),
            },
          );
          if (res.ok) {
            const body = (await res.json()) as Record<string, any>;
            text = body.candidates?.[0]?.content?.parts?.[0]?.text;
          } else {
            // overloaded or rate-limited is worth another go; a bad request is not
            transient = res.status === 503 || res.status === 429 || res.status >= 500;
            console.warn(`[gemini] ${model} answered ${res.status}`);
          }
        } catch (err) {
          console.warn(`[gemini] ${model} failed: ${(err as Error).name}`);
        }
        if (!transient) break;
        if (!text && attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 800));
      }
      if (text) break;
    }
    if (!text) return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.name !== "string" || parsed.name.length < 2) return null;
    if (parsed.confident === false) return null;

    const game = typeof parsed.game === "string" ? parsed.game.toLowerCase() : "other";
    return {
      name: parsed.name,
      game: [
        "pokemon", "mtg", "yugioh", "onepiece", "lorcana", "digimon",
        "starwars", "dragonball", "gundam", "unionarena", "riftbound", "sports",
      ].includes(game)
        ? game
        : "other",
      setName: typeof parsed.setName === "string" ? parsed.setName : null,
      edition: typeof parsed.edition === "string" ? parsed.edition : null,
      language: typeof parsed.language === "string" ? parsed.language : null,
      printing: typeof parsed.printing === "string" ? parsed.printing : null,
    };
  } catch {
    return null;
  }
}
