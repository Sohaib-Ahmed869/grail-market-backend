import { storePool } from "../cards.store.js";

// The console's own settings.
//
// One table of key/value pairs rather than a column per setting: these are
// operational knobs that get added and removed as policy changes, and a
// migration for each one is a migration nobody writes, so the setting ends up
// living in the page's `useState` instead. Which is exactly where every one of
// these was — typed into a form, applied to nothing, and gone on reload.
//
// Typed at the boundary. The table holds text; `DEFAULTS` says what each key
// means and what it falls back to, so a value that has never been set and a
// value that has been set to something unparseable both give the same safe
// answer rather than a NaN threshold that quietly lets everything through.

export const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
`;

/**
 * Every setting the console can change, with its default.
 *
 * The default is what the code does when nobody has said otherwise, so it has
 * to match what the code actually does today — `grailFloor` here and
 * `GRAIL_FLOOR` in `listings.store.ts` are the same number twice, and the day
 * they disagree the console will be describing a rule that is not enforced.
 */
export const DEFAULTS = {
  /* thresholds */
  grailFloor: 10000,
  highValueFloor: 2000,
  autoClear: false,
  autoClearHours: 24,
  sampleRate: 5,
  requireCert: true,
  blockLowConfidence: true,
  minPhotos: 4,
  sessionHours: 8,
  /* policy */
  pauseOnReport: true,
  reportWindowDays: 14,
  autoEscalateHours: 72,
  strikeLimit: 3,
  allowRaw: false,
  /* notifications */
  interceptOn: true,
} as const;

export type SettingKey = keyof typeof DEFAULTS;
export type Settings = { [K in SettingKey]: (typeof DEFAULTS)[K] extends boolean ? boolean : number };

const KEYS = Object.keys(DEFAULTS) as SettingKey[];
export const isSettingKey = (k: string): k is SettingKey => (KEYS as string[]).includes(k);

/** Text in, the declared type out. Anything unreadable falls to the default —
 *  a threshold that parses to NaN would compare false against everything and
 *  silently switch the rule off. */
function coerce<K extends SettingKey>(key: K, raw: string): Settings[K] {
  const fallback = DEFAULTS[key];
  if (typeof fallback === "boolean") {
    return (raw === "true" ? true : raw === "false" ? false : fallback) as Settings[K];
  }
  const n = Number(raw);
  return (Number.isFinite(n) ? n : fallback) as Settings[K];
}

export async function readSettings(): Promise<Settings> {
  const out = { ...DEFAULTS } as Settings;
  const pool = storePool();
  if (!pool) return out;
  try {
    const r = await pool.query("select key, value from admin_settings");
    for (const row of r.rows) {
      if (isSettingKey(row.key)) {
        (out as any)[row.key] = coerce(row.key, String(row.value));
      }
    }
  } catch {
    /* the table is new; the defaults are the answer until something is set */
  }
  return out;
}

/**
 * Write the ones that changed.
 *
 * Returns the keys it actually wrote, so the audit entry can name them. A save
 * that reports "settings updated" without saying which is an audit entry that
 * cannot be checked against anything.
 */
export async function writeSettings(
  patch: Record<string, unknown>,
  by: string,
): Promise<SettingKey[]> {
  const pool = storePool();
  if (!pool) return [];

  const current = await readSettings();
  const changed: SettingKey[] = [];

  for (const [k, v] of Object.entries(patch)) {
    if (!isSettingKey(k)) continue;
    const fallback = DEFAULTS[k];

    let value: string;
    if (typeof fallback === "boolean") {
      if (typeof v !== "boolean") continue;
      value = v ? "true" : "false";
    } else {
      const n = Number(v);
      // A threshold that is not a number is not a threshold. Refused rather
      // than stored and coerced back to the default on the next read, which
      // would look like the save had silently undone itself.
      if (!Number.isFinite(n) || n < 0) continue;
      value = String(n);
    }

    if (coerce(k, value) === current[k]) continue;

    await pool.query(
      `insert into admin_settings (key, value, updated_by, updated_at)
       values ($1, $2, $3, now())
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [k, value, by],
    );
    changed.push(k);
  }

  return changed;
}
