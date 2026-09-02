import { forgetToken } from "./store.js";

// Sending a notification.
//
// Expo's push service rather than APNs and FCM directly: the app is an Expo
// build, so it already has the token plumbing, and going direct would mean
// carrying an Apple key and a Firebase service account for no gain at this
// size. It is free and it is one HTTP call.
//
// A token that comes back DeviceNotRegistered is deleted immediately. A push
// table that never forgets grows a tail of dead devices and every send gets
// slower for nobody's benefit.

const ENDPOINT = "https://exp.host/--/api/v2/push/send";

export type Push = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export async function send(messages: Push[]): Promise<{ sent: number; dropped: number }> {
  if (messages.length === 0) return { sent: 0, dropped: 0 };
  let sent = 0, dropped = 0;

  // Expo takes 100 per request.
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
      for (const [n, r] of (body.data ?? []).entries()) {
        if (r.status === "ok") { sent++; continue; }
        dropped++;
        if (r.details?.error === "DeviceNotRegistered") {
          await forgetToken(batch[n].to).catch(() => {});
        }
      }
    } catch {
      // a failed send is not worth failing the job that produced it
    }
  }
  return { sent, dropped };
}
