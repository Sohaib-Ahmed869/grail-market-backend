/** Render's blueprint `fromService` injects a bare host ("x.onrender.com")
 *  with no scheme, and a schemeless URL makes fetch() throw. Accept both.
 *
 *  Lives in its own module because both scans.service.ts and tcgdex.ts need it
 *  at module-init time, and those two already import each other — putting it in
 *  either would make the cycle resolve to `undefined` at load.  */
export function normaliseVisionUrl(raw?: string): string {
  if (!raw) return "http://localhost:8100";
  const trimmed = raw.replace(/\/+$/, "");
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  // A bare service name with no dot ("grailcard-vision") is what Render's
  // `fromService … property: host` injects. It looks like a host but resolves
  // nowhere, and the only symptom is a 503 on every scan — so say so at boot
  // rather than letting it fail silently on each request.
  const host = url.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  if (host !== "localhost" && !host.includes(".")) {
    console.warn(
      `[vision] VISION_URL="${raw}" has no domain — resolved to ${url}, which will not route. ` +
        "Set it to the service's full public host.",
    );
  }
  return url;
}
