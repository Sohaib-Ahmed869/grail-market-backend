// Can an ordinary member push their own listing to market?
const API = process.env.API ?? "http://localhost:8180";
const PW = process.env.DEMO_PW;
const call = async (p, o = {}) => {
  const r = await fetch(`${API}${p}`, {
    method: o.method ?? "GET",
    headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
               ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const token = (await call("/auth/login", { method: "POST", body: { email: "ayna@yopmail.com", password: PW } })).body?.token;
console.log("signed in as an ordinary member:", Boolean(token));

const q = await call("/listings/queue", { token });
console.log("GET /listings/queue  ->", JSON.stringify(q.body).slice(0, 120));

const mine = await call("/listings/mine", { token });
const any = (mine.body?.listings ?? [])[0];
const rv = await call(`/listings/${any?.listing_id}/review`, { token, method: "POST", body: { approve: true } });
console.log("POST /listings/:id/review ->", JSON.stringify(rv.body).slice(0, 120));

const anon = await call("/listings/queue");
console.log("GET /listings/queue (no token) ->", JSON.stringify(anon.body).slice(0, 120));
