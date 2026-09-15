// Naming a card that no catalogue knows, from the text printed on it.
//
// This is the last resort, reached when every catalogue missed and the vision
// model gave no answer. It used to take the first all-capitals word the OCR
// offered, and on a Topps Chrome LeBron James that was "PPS" — the tail of the
// Topps logo — ahead of "TAKERS" (LAKERS, misread) and "LEBRON". The name was
// printed plainly on the card's nameplate as two words, LEBRON JAMES.
//
// So: card-brand words and their fragments are not names, team names are not
// names (even misread by a letter), and a person's name printed as consecutive
// words is preferred over any single word.

const BRAND_WORDS = [
  "TOPPS", "PANINI", "CHROME", "PRIZM", "SELECT", "DONRUSS", "OPTIC", "BOWMAN", "FLEER",
  "UPPER", "DECK", "REFRACTOR", "MOSAIC", "HOOPS", "CONTENDERS", "FINEST", "STADIUM",
  "MERLIN", "NATIONAL", "TREASURES", "IMMACULATE", "SPECTRA", "ROOKIE", "AUTOGRAPH",
  "BASKETBALL", "FOOTBALL", "BASEBALL", "SOCCER", "HOCKEY", "UEFA", "CHAMPIONS", "LEAGUE",
];
// Short tokens that are furniture on a sports card, matched exactly.
const SHORT_FURNITURE = new Set(["RC", "AUTO", "NBA", "NFL", "MLB", "NHL", "SP", "SSP", "CARD", "CARDS"]);

const TEAM_WORDS = [
  // NBA
  "HAWKS", "CELTICS", "NETS", "HORNETS", "BULLS", "CAVALIERS", "MAVERICKS", "NUGGETS", "PISTONS",
  "WARRIORS", "ROCKETS", "PACERS", "CLIPPERS", "LAKERS", "GRIZZLIES", "HEAT", "BUCKS",
  "TIMBERWOLVES", "PELICANS", "KNICKS", "THUNDER", "MAGIC", "SIXERS", "SUNS", "BLAZERS",
  "KINGS", "SPURS", "RAPTORS", "JAZZ", "WIZARDS",
  // NFL
  "CARDINALS", "FALCONS", "RAVENS", "BILLS", "PANTHERS", "BEARS", "BENGALS", "BROWNS",
  "COWBOYS", "BRONCOS", "LIONS", "PACKERS", "TEXANS", "COLTS", "JAGUARS", "CHIEFS", "RAIDERS",
  "CHARGERS", "RAMS", "DOLPHINS", "VIKINGS", "PATRIOTS", "SAINTS", "GIANTS", "JETS", "EAGLES",
  "STEELERS", "SEAHAWKS", "BUCCANEERS", "TITANS", "COMMANDERS",
  // MLB
  "DIAMONDBACKS", "BRAVES", "ORIOLES", "CUBS", "REDS", "GUARDIANS", "ROCKIES", "TIGERS",
  "ASTROS", "ROYALS", "ANGELS", "DODGERS", "MARLINS", "BREWERS", "TWINS", "METS", "YANKEES",
  "ATHLETICS", "PHILLIES", "PIRATES", "PADRES", "MARINERS", "RAYS", "RANGERS", "JAYS", "NATIONALS",
];

/** Name suffixes that follow a name rather than being one. */
const SUFFIXES = new Set(["II", "III", "IV", "JR", "SR"]);

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Is this one word card furniture rather than a name? A brand word, a piece
 *  of one ("PPS" out of TOPPS), or a team name, allowing one misread letter
 *  on longer words ("TAKERS" for LAKERS). */
export function isFurnitureWord(raw: string): boolean {
  const w = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!w) return true;
  if (SHORT_FURNITURE.has(w)) return true;
  for (const brand of BRAND_WORDS) {
    if (w === brand) return true;
    if (w.length >= 2 && w.length < brand.length && brand.includes(w) && w.length >= brand.length - 3) return true;
    if (w.length >= 5 && editDistance(w, brand) <= 1) return true;
  }
  for (const team of TEAM_WORDS) {
    if (w === team) return true;
    if (w.length >= 5 && editDistance(w, team) <= 1) return true;
  }
  return false;
}

/** Every word of this candidate is furniture. */
export function isFurnitureName(name: string): boolean {
  const words = String(name ?? "").split(/\s+/).filter(Boolean);
  return words.length === 0 || words.every(isFurnitureWord);
}

const isNameWord = (w: string) => /^[A-Za-z][A-Za-z.'-]{1,}$/.test(w) && !isFurnitureWord(w) && !SUFFIXES.has(w.toUpperCase().replace(/\./g, ""));

/** A person's name printed as consecutive words, e.g. a sports nameplate:
 *  "LEBRON" "JAMES" read as two OCR lines or one. The pair seen most often
 *  wins (nameplates are often read twice), and a trailing suffix is kept. */
export function personNameFromTexts(texts: readonly string[]): string | null {
  const words = texts.flatMap((t) => String(t ?? "").trim().split(/\s+/)).filter(Boolean);
  const seen = new Map<string, { count: number; last: number }>();
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!, b = words[i + 1]!;
    if (!isNameWord(a) || !isNameWord(b)) continue;
    const suffix = words[i + 2] && SUFFIXES.has(words[i + 2]!.toUpperCase().replace(/\./g, "")) ? ` ${words[i + 2]}` : "";
    const key = `${a} ${b}${suffix}`.toUpperCase();
    const prev = seen.get(key);
    seen.set(key, { count: (prev?.count ?? 0) + 1, last: i });
  }
  let best: [string, { count: number; last: number }] | null = null;
  for (const entry of seen) {
    if (!best || entry[1].count > best[1].count || (entry[1].count === best[1].count && entry[1].last > best[1].last)) {
      best = entry;
    }
  }
  return best ? best[0] : null;
}
