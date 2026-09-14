import { Controller, Get, Header, Param } from "@nestjs/common";
import { fxRates } from "../scans/fx.js";
import { sharedView } from "./view.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The shared collection as a web page.
 *
 *  A link somebody has to install an app to open is not a link you can send
 *  anyone, so the same token that the app reads as JSON also renders here, in
 *  a browser, with no account and no download. Anyone who does have the app
 *  gets the deep link at the top; everyone else gets the cards.
 *
 *  Server-rendered in one pass — no client script, no fetch, no spinner. The
 *  page is a snapshot of a collection, and a snapshot does not need a runtime.
 */
@Controller("c")
export class SharePageController {
  @Get(":token")
  @Header("content-type", "text/html; charset=utf-8")
  // Shared links are passed around; a proxy holding a stale copy would report
  // a collection that has since changed, or one that has been turned off.
  @Header("cache-control", "no-store")
  async page(@Param("token") token: string): Promise<string> {
    const view = await sharedView(String(token));
    if (!view) return shell("Link turned off", `
      <div class="gone">
        <h1>This link is off</h1>
        <p>Whoever shared it has turned it off, or it was never a link to a collection.</p>
        <a class="cta" href="https://grailcard.com.au">About GrailMarket</a>
      </div>`);

    const fx = await fxRates().catch(() => null);
    const rate = fx?.rates?.AUD ?? null;
    const aud = (usd: number) =>
      rate == null
        ? `US$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        : `A$${(usd * rate).toLocaleString("en-AU", { maximumFractionDigits: 2 })}`;

    const owner = esc(view.owner);
    const total = view.priced > 0 ? aud(view.value) : "&mdash;";
    const countLine = view.priced < view.cards
      ? `${view.cards} cards &middot; ${view.priced} priced, ${view.cards - view.priced} not valued yet`
      : `${view.cards} card${view.cards === 1 ? "" : "s"}`;

    const fan = view.entries.filter((e) => e.imageUrl).slice(0, 5);
    const rows = view.entries.map((e) => {
      const sub = [e.cardNumber && `#${e.cardNumber}`, e.setName,
                   e.grader && e.grade ? `${e.grader} ${e.grade}` : null,
                   e.quantity > 1 ? `&times;${e.quantity}` : null]
        .filter(Boolean).map(esc).join(" &middot; ");
      const price = e.value == null
        ? `<span class="nop">no price yet</span>`
        : aud(e.value * (e.quantity || 1));
      return `<li class="row">
        <div class="art">${e.imageUrl
          ? `<img loading="lazy" alt="" onerror="this.remove()" src="${esc(e.imageUrl)}">` : ""}</div>
        <div class="meta"><span class="name">${esc(e.cardName)}</span><span class="sub">${sub}</span></div>
        <div class="price">${price}</div>
      </li>`;
    }).join("");

    return shell(`${view.owner}'s collection`, `
      <header class="hero">
        <div class="fan">${fan.map((e, i) => `<img class="f${i}" alt="" onerror="this.remove()" src="${esc(e.imageUrl)}">`).join("")}</div>
        <p class="eyebrow">${owner}&rsquo;s collection</p>
        <p class="total">${total}</p>
        <p class="count">${countLine}</p>
        <a class="cta" href="grailmarket:///c/${esc(token)}">Open in GrailMarket</a>
      </header>
      <ul class="list">${rows || `<li class="empty">No cards in here yet.</li>`}</ul>
      <footer>
        <p>Valued at today&rsquo;s market. What ${owner} paid is not shared.</p>
        <p class="mark">GrailMarket</p>
      </footer>`);
  }
}

function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} &middot; GrailMarket</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap">
<style>
:root{
  --ground:#F2F4F7; --surface:#FFFFFF; --sunk:#F7F9FB;
  --ink:#1A2632; --muted:#4D5863; --faint:#6A737D;
  --line:#E3E8ED; --gold:#A88D60;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#121A23; --surface:#1A2632; --sunk:#16202B;
  --ink:#F2F4F7; --muted:#B7C0C9; --faint:#8C97A2;
  --line:#26323F; --gold:#C6AC7E;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font:400 15px/1.5 Outfit,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:28px 20px 64px}
.hero{text-align:center;padding:8px 0 4px}
.fan{height:150px;display:flex;align-items:center;justify-content:center}
.fan img{width:98px;height:136px;object-fit:cover;border-radius:9px;
  border:2px solid var(--surface);box-shadow:0 8px 24px rgba(26,38,50,.18);background:var(--sunk)}
.fan img+img{margin-left:-40px}
.f0{transform:rotate(-11deg)}.f1{transform:rotate(-5deg)}.f2{transform:rotate(0)}
.f3{transform:rotate(5deg)}.f4{transform:rotate(11deg)}
.eyebrow{margin:22px 0 2px;font-size:12px;font-weight:600;letter-spacing:.10em;
  text-transform:uppercase;color:var(--faint)}
.total{margin:0;font-size:44px;line-height:1.1;font-weight:700;letter-spacing:-1.4px;
  font-variant-numeric:tabular-nums}
.count{margin:6px 0 0;color:var(--muted);font-size:14px}
.cta{display:inline-flex;align-items:center;justify-content:center;margin-top:22px;
  padding:13px 26px;border-radius:999px;background:var(--ink);color:var(--ground);
  font-weight:600;text-decoration:none}
.cta:hover{opacity:.9}
.list{list-style:none;margin:36px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.row{display:flex;align-items:center;gap:14px;padding:10px 14px;border-radius:12px;
  background:var(--surface);box-shadow:0 1px 2px rgba(26,38,50,.06)}
.art{width:44px;height:61px;flex:none;border-radius:6px;overflow:hidden;background:var(--sunk)}
.art img{width:100%;height:100%;object-fit:cover;display:block}
.meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{font-size:13px;color:var(--faint);display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden}
.price{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.nop{font-weight:400;font-size:13px;color:var(--faint)}
.empty{padding:28px;text-align:center;color:var(--faint);background:var(--surface);border-radius:12px}
footer{margin-top:34px;text-align:center;color:var(--faint);font-size:13px}
footer p{margin:4px 0}
.mark{font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-size:11px}
.gone{text-align:center;padding:80px 0}
.gone h1{font-size:26px;margin:0 0 8px}
.gone p{color:var(--muted);margin:0 auto;max-width:34ch}
</style></head><body><main>${body}</main></body></html>`;
}
