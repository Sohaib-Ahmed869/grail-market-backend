import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Minimal .env loader: KEY=VALUE lines. Three copies of this used to live in
// main.ts, ingest/main.ts and ingest/keys.ts, and all three shared two traps
// that cost a live deploy half an hour.
//
// FIRST occurrence wins, and a duplicate used to be silent. Setting a variable
// with `echo 'X=<paste it>' >> .env` and then correcting it in an editor
// leaves the placeholder ABOVE the real line, so the placeholder is what runs.
// On PPT_KEY_SECRET that produced ten keys reported as UNDECRYPTABLE with a
// correct-looking .env on screen. Precedence is unchanged — a duplicate is now
// just impossible to miss.
//
// And the value was matched with a greedy `(.*)` before `\s*$`, so trailing
// whitespace ended up INSIDE the value. A secret is fed to scryptSync verbatim,
// where one trailing space is the difference between decrypting and not, with
// nothing on screen to see.
export function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return;

  const seen = new Set<string>();
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key] = m;
    let value = m[2];
    // a value the shell would have unquoted
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
    }
    if (seen.has(key)) {
      console.warn(
        `[env] ${key} is set more than once in .env — the FIRST one wins and the rest are ignored`,
      );
      continue;
    }
    seen.add(key);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
