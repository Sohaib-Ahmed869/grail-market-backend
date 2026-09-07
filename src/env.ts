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
//
// And the two that cost THIS one. A missing .env returned in silence, so a
// process started from the wrong directory — which is what a `pm2 restart`
// does when its saved cwd is not the repo — booted with no configuration at
// all and said nothing until somebody used a feature that needed a key. And
// an EMPTY value in the real environment counted as "already set", so a
// `DIDIT_API_KEY=` left in a process manager's saved env silently beat the
// real key in the file. Both present as one symptom: a key that is plainly in
// .env, reported as not set.
export function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) {
    // Loud, because the alternative is a server that looks healthy and is not
    // configured. It names the path so the answer is "I looked here" rather
    // than "something is wrong somewhere".
    console.warn(
      `[env] no .env at ${envPath} — nothing was loaded. ` +
        `If this is a deployment, the process was started from the wrong ` +
        `directory and every key will read as unset.`,
    );
    return;
  }

  const seen = new Set<string>();
  let loaded = 0;
  const overridden: string[] = [];
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
    // An empty string is not a value. `DIDIT_API_KEY=` sitting in a process
    // manager's remembered environment is `""`, which is `!== undefined` and
    // therefore used to win over the real key three lines below it in the
    // file — and `Boolean("")` is false, so the feature reported the key as
    // not set while it was visibly in .env.
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      loaded += 1;
    } else if (process.env[key] !== value) {
      overridden.push(key);
    }
  }

  // What was read, and what the environment overrode. One line, at boot,
  // because "which of these two copies is running" is the question every one
  // of these incidents has turned on.
  console.log(
    `[env] read ${envPath}: ${loaded} set` +
      (overridden.length
        ? `, ${overridden.length} already in the environment and left alone ` +
          `(${overridden.join(", ")})`
        : ""),
  );
}
