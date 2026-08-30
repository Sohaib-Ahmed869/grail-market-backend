import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "../env.js";
import { join } from "node:path";

// Manage the encrypted provider-key pool.
//
//   npm run keys -- --list
//   npm run keys -- --add <key> [--label "free account 3"]
//   npm run keys -- --import-env        move PPT_API_KEY into the store
//   npm run keys -- --disable <id>
//   npm run keys -- --enable  <id>
//
// Key material is accepted as an argument and never printed back. Everything
// this reports is the 8-char id.

loadEnvFile();

const { addKey, listKeys, setKeyDisabled, keystoreConfigured } = await import(
  "../scans/keystore.js"
);
const { storeConfigured } = await import("../cards.store.js");

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

if (!storeConfigured()) {
  console.error("[keys] DATABASE_URL is not set — the pool lives in Postgres");
  process.exit(1);
}
if (!keystoreConfigured()) {
  console.error(
    "[keys] PPT_KEY_SECRET is not set.\n" +
      "       Generate one and put it in .env:\n" +
      '         node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
      "       Keep it safe: without it every stored key is unrecoverable.",
  );
  process.exit(1);
}

async function show(): Promise<void> {
  const keys = await listKeys();
  if (keys.length === 0) {
    console.log("[keys] the pool is empty");
    return;
  }
  console.log(`[keys] ${keys.length} key(s)`);
  for (const k of keys) {
    const state = k.disabled ? "disabled" : k.decryptable ? "live" : "UNDECRYPTABLE";
    console.log(
      `  ${k.id}  ${state.padEnd(14)} ${(k.label ?? "").padEnd(22)} added ${k.addedAt.slice(0, 10)}` +
        (k.lastOkAt ? `  last ok ${k.lastOkAt.slice(0, 10)}` : ""),
    );
  }
  const broken = keys.filter((k) => !k.decryptable && !k.disabled);
  if (broken.length) {
    console.warn(
      `[keys] ${broken.length} key(s) will not decrypt — PPT_KEY_SECRET does not match the one they were stored with`,
    );
  }
}

if (args.includes("--list") || args.length === 0) {
  await show();
} else if (args.includes("--import-env")) {
  const raw = process.env.PPT_API_KEY ?? "";
  const keys = raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    console.error("[keys] PPT_API_KEY is empty — nothing to import");
    process.exit(1);
  }
  let added = 0;
  let already = 0;
  for (const [i, k] of keys.entries()) {
    const r = await addKey(k, `imported from env #${i + 1}`);
    r.added ? added++ : already++;
    console.log(`  ${r.id}  ${r.added ? "added" : "already present"}`);
  }
  console.log(`[keys] imported ${added}, ${already} already in the pool`);
  console.log(
    "[keys] the keys are in the store now. You can shorten PPT_API_KEY in .env to\n" +
      "       a single fallback key, or clear it entirely — but keep PPT_KEY_SECRET,\n" +
      "       because nothing decrypts without it.",
  );
} else if (flag("--add")) {
  const r = await addKey(flag("--add")!, flag("--label"));
  console.log(`[keys] ${r.id} ${r.added ? "added" : "was already in the pool"}`);
} else if (flag("--disable")) {
  const ok = await setKeyDisabled(flag("--disable")!, true);
  console.log(ok ? `[keys] ${flag("--disable")} disabled` : "[keys] no such key");
} else if (flag("--enable")) {
  const ok = await setKeyDisabled(flag("--enable")!, false);
  console.log(ok ? `[keys] ${flag("--enable")} enabled` : "[keys] no such key");
} else {
  console.error("[keys] unknown arguments. See the header of src/ingest/keys.ts");
  process.exit(1);
}

process.exit(0);
