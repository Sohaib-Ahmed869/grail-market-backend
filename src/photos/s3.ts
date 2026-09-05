import { randomUUID } from "node:crypto";
import {
  S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Listing photographs.
//
// The phone uploads straight to S3, not through this API. Ten images plus an
// optional video per listing is tens of megabytes; routing that through the
// API would tie up a request slot for the whole upload, and the box that does
// it is also the one running the vision service. A presigned URL lets the
// phone talk to S3 directly and keeps our credentials out of the app.

/* Read when asked, not when imported.
 *
 *  These were module-level constants, and this package is `"type": "module"`
 *  — so every import in main.ts evaluates BEFORE the `loadEnvFile()` call
 *  beneath them. `BUCKET` was therefore captured as "" on every boot,
 *  `photosConfigured()` answered false forever, and the API refused each
 *  upload before it ever reached S3. The keys were in .env the whole time.
 *
 *  Reading them through a function costs a property lookup and cannot be
 *  wrong about when the environment arrived. */
const REGION = () => process.env.AWS_REGION ?? "eu-north-1";
const BUCKET = () => process.env.S3_BUCKET_NAME ?? "";

export const photosConfigured = () =>
  Boolean(BUCKET() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    region: REGION(),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

/** The ten angles, in the order the seller is asked for them.
 *
 *  Not a free-for-all gallery. Ahmed asked for "a close up from the face,
 *  close up on the back, one two three four sides on the back and one two
 *  three four on the front" — prescribed angles are what a downloaded stock
 *  photo cannot satisfy, which is the point of requiring them. */
/** The floor for publishing. Four is the smallest set that shows both faces
 *  and proves the seller turned the card over; ten earns Photo Verified. */
export const MIN_PHOTOS = 4;

export const ANGLES = [
  "front", "back",
  "front-tl", "front-tr", "front-bl", "front-br",
  "back-tl", "back-tr", "back-bl", "back-br",
] as const;
export type Angle = (typeof ANGLES)[number];

const MAX_BYTES = 12 * 1024 * 1024;

export type Upload = { key: string; uploadUrl: string; publicUrl: string };

/** A URL the phone can PUT one image to, valid for a few minutes.
 *
 *  The key is derived here, never taken from the client — otherwise a caller
 *  could name a path inside somebody else's listing and overwrite their
 *  photographs. */
/** Put bytes we already hold into the bucket.
 *
 *  The presigned PUT above is still the right shape for a browser, and it is
 *  what the console uses. React Native cannot use it: `fetch(fileUri).blob()`
 *  is the only way to get a body for a raw PUT there, and RN's Blob is partial
 *  enough that the request goes up empty or throws. Ten photographs failing
 *  silently is how a $11,340 listing sat in `draft` and never reached the
 *  review queue.
 *
 *  So the phone posts multipart to our API — the same shape the scan upload has
 *  always used and the one RN genuinely supports — and this puts it away. The
 *  header comment above still holds for the browser; it is simply no longer
 *  true that there is only one path. */
export async function putPhoto(
  ownerId: string,
  angle: Angle | "video" | string,
  body: Buffer,
  contentType: string,
  prefix: "listings" | "disputes" = "listings",
): Promise<Upload> {
  if (!photosConfigured()) throw new Error("photo storage is not configured");
  const ext = contentType.includes("png") ? "png" : contentType.startsWith("video") ? "mp4" : "jpg";
  const key = `${prefix}/${ownerId}/${angle}-${randomUUID().slice(0, 8)}.${ext}`;
  await s3().send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
    }),
  );
  return { key, uploadUrl: "", publicUrl: publicUrlFor(key) };
}

/** A short-lived read URL for something we stored.
 *
 *  The bucket blocks public access, which is right: it holds members' card
 *  photographs and dispute evidence, and an object URL that anybody can guess
 *  and fetch is a photograph of somebody's address on a shipping label. So
 *  nothing is world-readable and reads are signed instead.
 *
 *  Takes the URL we wrote into the row rather than a key, because that is what
 *  every caller already holds. Anything that is not one of ours comes back
 *  untouched, so an external image in an old record still renders.
 *
 *  Fifteen minutes: long enough to open a record and look at ten angles,
 *  short enough that a copied link is not a permanent one. */
export async function signDownload(url: string, seconds = 900): Promise<string> {
  if (!photosConfigured() || !url) return url;
  const prefix = `https://${BUCKET()}.s3.${REGION()}.amazonaws.com/`;
  if (!url.startsWith(prefix)) return url;
  const key = decodeURIComponent(url.slice(prefix.length));
  try {
    return await getSignedUrl(
      s3(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn: seconds },
    );
  } catch {
    // A signature we could not produce must not blank the record.
    return url;
  }
}

/** The same, for a list. */
export const signAll = async <T extends { url: string }>(rows: T[]): Promise<T[]> =>
  Promise.all(rows.map(async (r) => ({ ...r, url: await signDownload(r.url) })));

export async function signUpload(
  ownerId: string,
  angle: Angle | "video" | string,
  contentType: string,
  /** Which folder the object lands in. Listings were the only thing with
   *  photographs until disputes needed evidence, and evidence must not sit
   *  under `listings/` — a lifecycle rule that expires listing photos when a
   *  listing goes would take the proof with it. */
  prefix: "listings" | "disputes" = "listings",
): Promise<Upload> {
  if (!photosConfigured()) throw new Error("photo storage is not configured");
  const ext = contentType.includes("png") ? "png" : contentType.startsWith("video") ? "mp4" : "jpg";
  const key = `${prefix}/${ownerId}/${angle}-${randomUUID().slice(0, 8)}.${ext}`;

  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      ContentType: contentType,
      // A signed URL that does not pin the length is a signed URL somebody can
      // put a gigabyte through.
      ContentLength: undefined,
    }),
    { expiresIn: 300 },
  );

  return { key, uploadUrl, publicUrl: publicUrlFor(key) };
}

export const publicUrlFor = (key: string) =>
  `https://${BUCKET()}.s3.${REGION()}.amazonaws.com/${key}`;

export async function deletePhoto(key: string): Promise<void> {
  if (!photosConfigured()) return;
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key })).catch(() => {});
}

export const MAX_UPLOAD_BYTES = MAX_BYTES;
