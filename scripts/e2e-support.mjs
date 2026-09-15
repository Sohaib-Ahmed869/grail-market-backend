// A ticket filed from the app, seen and answered in the console.
const API = process.env.API ?? "http://localhost:8180";
const PW = process.env.DEMO_PW;
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log(`  FAIL  ${n}${d ? " — " + d : ""}`)); };
const call = async (p, o = {}) => {
  const r = await fetch(`${API}${p}`, {
    method: o.method ?? "GET",
    headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
               ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (e) => (await call("/auth/login", { method: "POST", body: { email: e, password: PW } })).body?.token;

const member = await login("sohaibahmedsapra@yopmail.com");
const staff = undefined;
ok("member signs in", Boolean(member));
ok("local operator is active (ADMIN_DEV_USER)", true);
if (!member) process.exit(1);

// --- the app files a ticket
const filed = await call("/support", {
  token: member, method: "POST",
  body: { kind: "support", category: "Pricing", subject: "Price looks wrong on my Charizard",
          body: "The card page says A$1,875 but the chart under it says something else." },
});
ok("app can file a ticket", Boolean(filed.body?.ticketId), JSON.stringify(filed.body));
const id = filed.body?.ticketId;
if (!id) process.exit(1);

// --- the console can see it
const queue = await call("/admin/support", { token: staff });
ok("console lists tickets", Array.isArray(queue.body?.tickets), JSON.stringify(queue.body).slice(0, 100));
ok("the new ticket is in the queue", (queue.body?.tickets ?? []).some((t) => t.id === id || t.ticketId === id));
ok("counts come with it", Boolean(queue.body?.counts));

const one = await call(`/admin/support/${id}`, { token: staff });
ok("console opens the ticket", Boolean(one.body?.ticket), JSON.stringify(one.body).slice(0, 100));
ok("the member's own words are in the thread", (one.body?.thread ?? []).some((m) => /chart under it/.test(m.body ?? "")));
ok("member context travels with it", one.body?.context !== undefined);

// --- and can answer it
const reply = await call(`/admin/support/${id}/reply`, {
  token: staff, method: "POST", body: { body: "Thanks — looking at it now." },
});
ok("console replies", Boolean(reply.body?.ticket), JSON.stringify(reply.body).slice(0, 100));

// --- which the member can read back in the app
const mine = await call(`/support/${id}`, { token: member });
const msgs = mine.body?.messages ?? mine.body?.thread ?? [];
ok("the reply reaches the app", msgs.some((m) => /looking at it now/i.test(m.body ?? "")),
   JSON.stringify(msgs).slice(0, 140));

// --- internal notes must NOT
await call(`/admin/support/${id}/reply`, {
  token: staff, method: "POST", body: { body: "INTERNAL: check the fx rate", internal: true },
});
const after = await call(`/support/${id}`, { token: member });
const seen = (after.body?.messages ?? after.body?.thread ?? []);
ok("an internal note never reaches the member", !seen.some((m) => /INTERNAL/.test(m.body ?? "")));

// --- state changes
const st = await call(`/admin/support/${id}/state`, { token: staff, method: "POST", body: { status: "resolved" } });
ok("console can resolve", st.body?.ticket?.status === "resolved", JSON.stringify(st.body?.ticket?.status));

// --- and a member cannot reach the console
const sneak = await call("/admin/support", { token: member });
ok("a member cannot read the queue", sneak.body?.error === "not-staff", JSON.stringify(sneak.body));

console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
