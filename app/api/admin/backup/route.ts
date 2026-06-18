import { NextRequest, NextResponse } from 'next/server';
import { list, get } from '@vercel/blob';
import JSZip from 'jszip';
import { requirePermission } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico'];

function isImage(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'clear_data');
  if (guard instanceof NextResponse) return guard;

  try {
    const zip = new JSZip();
    let cursor: string | undefined;
    let totalBlobs = 0;

    // Paginate through all blobs
    do {
      const result = await list({ cursor, limit: 1000 });

      for (const blob of result.blobs) {
        try {
          // Private store: blob.url is NOT publicly fetchable (403). Read via the
          // authenticated get() + stream — same pattern the data layers use.
          const obj = await get(blob.pathname, { access: 'private', useCache: false });
          if (!obj || obj.statusCode !== 200 || !obj.stream) {
            console.warn(`[backup] Failed to read blob: ${blob.pathname}`);
            continue;
          }

          const buffer = Buffer.from(await new Response(obj.stream).arrayBuffer());

          if (isImage(blob.pathname)) {
            zip.file(blob.pathname, buffer, { binary: true });
          } else {
            zip.file(blob.pathname, buffer.toString('utf-8'));
          }
          totalBlobs++;
        } catch (err) {
          console.warn(`[backup] Skipping blob ${blob.pathname}:`, err);
          continue;
        }
      }

      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);

    if (totalBlobs === 0) {
      return NextResponse.json({ error: 'No blobs found to back up' }, { status: 404 });
    }

    const zipBuffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    const today = new Date().toISOString().slice(0, 10);
    const filename = `iram-backup-${today}.zip`;

    return new Response(zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipBuffer.length),
      },
    });
  } catch (err) {
    console.error('[backup] Error generating backup:', err);
    return NextResponse.json(
      { error: 'Failed to generate backup' },
      { status: 500 },
    );
  }
}
