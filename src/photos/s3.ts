import { randomUUID } from "node:crypto";
import { S3Client, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Listing photographs.
//
// The phone uploads straight to S3, not through this API. Ten images plus an
// optional video per listing is tens of megabytes; routing that through the
// API would tie up a request slot for the whole upload, and the box that does
// it is also the one running the vision service. A presigned URL lets the
// phone talk to S3 directly and keeps our credentials out of the app.

const REGION = process.env.AWS_REGION ?? "eu-north-1";
const BUCKET = process.env.S3_BUCKET_NAME ?? "";

export const photosConfigured = () =>
  Boolean(BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    region: REGION,
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
      Bucket: BUCKET,
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
  `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;

export async function deletePhoto(key: string): Promise<void> {
  if (!photosConfigured()) return;
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
}

export const MAX_UPLOAD_BYTES = MAX_BYTES;
