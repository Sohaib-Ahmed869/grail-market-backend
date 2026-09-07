/**
 * Set an account's password directly, from the box that owns the database.
 *
 *   npx tsx scripts/set-password.mts admin@grailmarket.com
 *
 * The recovery path of last resort. Every other way to change a password
 * proves you are already the owner of the account — `changePassword` asks for
 * the current one, and the reset link asks for the mailbox. Both are the right
 * shape for a user. Neither helps the person holding DATABASE_URL when the
 * mailer is not wired up yet and the only owner account is locked out, and the
 * thing that person does instead is paste a hand-built hash into psql, which
 * is how a password column ends up holding something `verifyPassword` cannot
 * read.
 *
 * So: same `hashPassword`, same column, same `password_changed_at`. The only
 * thing missing from the supported paths is the proof, and the proof here is
 * shell access to the database — which is strictly more authority than either
 * of the others, not less.
 *
 * It will not create an account. An address with no row is a typo far more
 * often than it is an intention, and a script that helpfully invents an owner
 * account for a misspelled address is a back door with a friendly face.
 *
 * The password is read from the terminal, not from argv: an argument lands in
 * shell history and in the process list, where it outlives the reset. Piping
 * works too (`echo … | npx tsx …`) for the scripted case.
 */
import { createInterface } from "node:readline";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { hashPassword } = await import("../src/auth/passwords.js");

const args = process.argv.slice(2);
const allowShort = args.includes("--allow-short");
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: npx tsx scripts/set-password.mts <email> [--allow-short]");
  process.exit(1);
}

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to change.");
  process.exit(1);
}

/** Ten characters, because that is what the sign-up form and both supported
 *  change paths enforce. A back door with a weaker policy than the front door
 *  is the policy.
 *
 *  `--allow-short` lifts it, because sign-in does not check length at all
 *  (auth.controller.ts:69) and so a shorter password set here really does work.
 *  The flag exists so that choice is typed out loud and lands in the shell
 *  history of whoever made it, rather than being a limit this script quietly
 *  never had. What it sets cannot be re-set through the app's own
 *  change-password form, which still demands ten. */
const MIN_LENGTH = 10;

/** Prompt without echoing. Node has no built-in for this, and the trick is to
 *  let readline handle the line editing while writing nothing back to the
 *  terminal but the prompt itself. */
function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped in. Take the first line and do not pretend to prompt.
    return new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => resolve(buf.split("\n")[0]));
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    // readline echoes every keystroke through here; swallow all of it after
    // the prompt has been drawn once.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {
      if (!shown) {
        process.stdout.write(prompt);
        shown = true;
      }
    };
    rl.question(prompt, (answer) => {
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

const pool = storePool()!;

const found = await pool.query(
  `select user_id, email, name, role, (mfa_secret is not null) as mfa_on
     from users where lower(email) = $1`,
  [email],
);

if (!found.rowCount) {
  console.error(`No account for ${email}. Nothing changed.`);
  await pool.end();
  process.exit(1);
}

const user = found.rows[0];
console.log(`\n  ${user.name} · ${user.email} · role ${user.role}\n`);

const next = await askHidden("New password: ");
if (!next.length) {
  console.error("\nEmpty. Nothing changed.");
  await pool.end();
  process.exit(1);
}
if (next.length < MIN_LENGTH && !allowShort) {
  console.error(
    `\nToo short — use at least ${MIN_LENGTH} characters, or pass --allow-short. Nothing changed.`,
  );
  await pool.end();
  process.exit(1);
}

// Asked twice on a terminal, because a typo here locks out the same account
// this script exists to unlock. Skipped when piped: the caller already knows
// what they sent.
if (process.stdin.isTTY) {
  const again = await askHidden("Again: ");
  if (again !== next) {
    console.error("\nThe two did not match. Nothing changed.");
    await pool.end();
    process.exit(1);
  }
}

await pool.query(
  "update users set password = $2, password_changed_at = now() where user_id = $1",
  [user.user_id, await hashPassword(next)],
);

console.log(`\nPassword set for ${user.email}.`);
if (next.length < MIN_LENGTH) {
  console.log(
    `Note: ${next.length} characters. Sign-in accepts it; the change-password form will not.`,
  );
}

// Sessions are signed with AUTH_SECRET and carry no password stamp, so any
// session issued before now still works. Worth knowing if the reason for the
// reset was that somebody else had the old password.
if (user.mfa_on) console.log("This account also has MFA — you will still be asked for a code.");

await pool.end();
process.exit(0);
