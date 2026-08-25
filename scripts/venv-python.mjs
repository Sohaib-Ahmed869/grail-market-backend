// Resolve the venv interpreter across platforms: POSIX puts it in
// .venv/bin, Windows in .venv/Scripts. Hardcoding either breaks the other,
// which is how `npm run dev:vision` silently died on macOS.
//
// Usage: node scripts/venv-python.mjs [--cwd <dir>] <python args...>
// Paths resolve against the repo root, not the caller's cwd, so --cwd is
// safe to use (pytest needs the vision directory as cwd for its fixtures).
//
// VISION_DIR overrides where the service lives, and the default is searched
// rather than assumed — the directory moved once when the backend was split
// into its own repo, and a hardcoded path turned that into a silent failure
// telling people to create a venv they already had.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VISION_DIRS = [
  process.env.VISION_DIR,
  join(ROOT, "vision"),
  join(ROOT, "services", "vision"),
].filter(Boolean);
const visionDir =
  VISION_DIRS.find((d) => existsSync(join(d, "requirements.txt"))) ?? VISION_DIRS[1];
const VENV = join(visionDir, ".venv");

const argv = process.argv.slice(2);
let cwd = ROOT;
if (argv[0] === "--cwd") {
  cwd = resolve(ROOT, argv[1]);
  argv.splice(0, 2);
}

const candidates = [
  join(VENV, "bin", "python"),
  join(VENV, "Scripts", "python.exe"),
  join(VENV, "Scripts", "python"),
];
const python = candidates.find(existsSync);
if (!python) {
  console.error(
    `No venv interpreter found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}\n\n` +
      `Create one with:\n  python3 -m venv ${VENV}\n` +
      `  ${join(VENV, "bin", "pip")} install -r ${join(visionDir, "requirements.txt")}`,
  );
  process.exit(1);
}

spawn(python, argv, { stdio: "inherit", cwd }).on("exit", (code) => process.exit(code ?? 1));
