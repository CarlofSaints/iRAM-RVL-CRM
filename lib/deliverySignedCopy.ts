/**
 * Photo of a hand-signed paper delivery note.
 *
 * When the phone at the vendor has no signal, the receiver signs the printed
 * delivery note and the rep photographs it; the sign-off is sent later from
 * the phone. That photo is the signature of record, so it is kept in its own
 * blob (one per delivery token) rather than copied onto every slip's run blob
 * the way a drawn signature is — a photo is ~100x a canvas PNG, and a 30-store
 * delivery would otherwise put it in the run blob 30 times.
 */
import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';

/** Largest photo the sign-off accepts, decoded. The page shrinks photos to
 *  ~300KB before sending, so this only stops a raw camera file. */
export const MAX_SIGNED_COPY_BYTES = 3 * 1024 * 1024;

const keyFor = (token: string) => `deliverySignedCopies/${token}.jpg`;
// Off Vercel (local dev) the photo lives under data/, like the pick slips do.
const localPath = (key: string) => path.join(process.cwd(), 'data', key);

/** Validates a `data:image/...;base64,` URL and returns its bytes, or an
 *  error message for the person signing. */
export function parseSignedCopy(dataUrl: unknown): { bytes: Buffer; contentType: string } | { error: string } {
  if (typeof dataUrl !== 'string') return { error: 'The photo of the signed delivery note was not received.' };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) return { error: 'The signed delivery note must be a photo (JPEG or PNG).' };
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) return { error: 'The photo of the signed delivery note is empty.' };
  if (bytes.length > MAX_SIGNED_COPY_BYTES) return { error: 'The photo is too large. Please take it again.' };
  return { bytes, contentType: m[1] };
}

/** Stores the photo. Returns the blob key recorded on each slip. */
export async function saveSignedCopy(token: string, bytes: Buffer, contentType: string): Promise<string> {
  const key = keyFor(token);
  if (!process.env.VERCEL) {
    fs.mkdirSync(path.dirname(localPath(key)), { recursive: true });
    fs.writeFileSync(localPath(key), bytes);
    return key;
  }
  await put(key, bytes, {
    access: 'private',
    contentType,
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return key;
}

/** Reads the photo back as a data URL for the PDF generator, or undefined. */
export async function loadSignedCopy(key: string | undefined): Promise<string | undefined> {
  if (!key) return undefined;
  try {
    if (!process.env.VERCEL) {
      const p = localPath(key);
      return fs.existsSync(p) ? `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` : undefined;
    }
    const res = await get(key, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200) return undefined;
    const buf = Buffer.from(await new Response(res.stream).arrayBuffer());
    const type = res.blob.contentType || 'image/jpeg';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error('[deliverySignedCopy] read failed', key, err instanceof Error ? err.message : err);
    return undefined;
  }
}
