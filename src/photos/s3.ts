import { randomUUID } from "node:crypto";
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Listing photographs.
//
// The phone uploads straight to S3, not through this API. Ten images plus an
// optional video per listing is tens of megabytes; routing that through the
// API would tie up a request slot for the whole upload, and the box that does
// it is also the one running the vision service. A presigned URL lets the
// phone talk to S3 directly and keeps our credentials out of the app.

/* Read when they are used, not when this file is first imported.
 *
 * `main.ts` calls `loadEnvFile()` on line nine — but an ES `import` is
 * hoisted, so every module body in the tree has already run by the time that
 * line is reached. A `const BUCKET = process.env.S3_BUCKET_NAME` here is
 * therefore evaluated against an environment that has not been loaded yet,
 * and comes out empty. Nothing throws: `photosConfigured()` quietly answers
 * false, `publicUrlFor` builds `https://.s3.…`, and a signed URL is silently
 * never produced. Functions cost nothing and cannot be caught out by import
 * order. */
const region = () => process.env.AWS_REGION ?? "eu-north-1";
const bucket = () => process.env.S3_BUCKET_NAME ?? "";

export const photosConfigured = () =>
  Boolean(bucket() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    region: region(),
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
      Bucket: bucket(),
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
  `https://${bucket()}.s3.${region()}.amazonaws.com/${key}`;

/**
 * `publicUrlFor` is a misnomer, and it cost us every listing photograph.
 *
 * The bucket is not public-read — it should not be; these are photographs of
 * somebody's property, taken to prove they hold it. So the URL that function
 * builds is a correct ADDRESS and not a working link: anyone who follows it
 * gets a 403 from S3. The upload side was always signed, which is why nobody
 * noticed: putting a photo up worked, and reading it back never did.
 *
 * `viewableUrl` is the missing half. It signs a short-lived GET for anything
 * that lives in our own bucket, and hands back anything else untouched — the
 * seeded fixtures point at tcgdex and scryfall, which are public and must not
 * be mangled into a signature for a bucket they are not in.
 */
const origin = () => `https://${bucket()}.s3.${region()}.amazonaws.com/`;

/** The object key inside our bucket, or null for a URL that is not ours. */
export function keyFromUrl(url: string): string | null {
  const o = origin();
  if (!bucket() || !url.startsWith(o)) return null;
  const key = decodeURIComponent(url.slice(o.length));
  return key.length > 0 ? key : null;
}

/**
 * A link that will actually load, valid for fifteen minutes.
 *
 * Long enough to read a record and look at ten photographs, short enough that
 * a URL copied out of the network tab is not a permanent hole in a private
 * bucket. It has to be re-signed on every read, which is why this is done
 * when the record is served rather than stored on the row.
 */
export async function viewableUrl(url: string, expiresIn = 900): Promise<string> {
  const key = keyFromUrl(url);
  if (!key || !photosConfigured()) return url;
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
      expiresIn,
    });
  } catch {
    /* A signature we could not produce is not a reason to lose the record.
       The console draws an unreachable photograph as "would not load", which
       is the truth either way. */
    return url;
  }
}

export async function deletePhoto(key: string): Promise<void> {
  if (!photosConfigured()) return;
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })).catch(() => {});
}

export const MAX_UPLOAD_BYTES = MAX_BYTES;
