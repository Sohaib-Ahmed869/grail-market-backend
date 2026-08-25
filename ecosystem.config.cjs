// pm2 process definitions. Both services, one file.
//
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup      # survive a reboot
//
// .cjs, not .js: package.json sets "type":"module" and pm2 loads this with
// require(), which fails on an ESM file with an error that names neither.
module.exports = {
  apps: [
    {
      name: "grail-vision",
      // absolute-ish paths resolved from cwd so pm2 can be run from anywhere
      script: "vision/.venv/bin/python",
      args: "-m uvicorn app.main:app --app-dir vision --host 127.0.0.1 --port 8100",
      interpreter: "none",           // the script IS the interpreter
      instances: 1,                  // the OCR model is ~350 MB resident; one copy
      autorestart: true,
      // A runaway request restarts this service instead of the kernel picking a
      // victim — which on a 2 GB box has been known to be sshd.
      max_memory_restart: "1200M",
      // The model takes ~20s to load on first start. Without this pm2 counts a
      // still-loading process as a crash loop and gives up.
      min_uptime: "40s",
      max_restarts: 10,
      env: { PYTHONUNBUFFERED: "1" },
    },
    {
      name: "grail-api",
      script: "node_modules/.bin/tsx",
      args: "src/main.ts",
      interpreter: "none",
      instances: 1,
      autorestart: true,
      max_memory_restart: "600M",
      min_uptime: "15s",
      // .env is read by the app itself; listed here so `pm2 env` shows the port
      env: { NODE_ENV: "production" },
    },
  ],
};
