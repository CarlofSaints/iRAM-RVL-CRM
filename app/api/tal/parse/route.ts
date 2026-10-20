import { NextRequest, NextResponse } from 'next/server';
import { extractText, getDocumentProxy } from 'unpdf';
import { requirePermission } from '@/lib/rolesData';
import { parseBookingText } from '@/lib/talShared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/tal/parse — read a Booking Confirmation PDF. Saves nothing; the user checks the result first. */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'import_excel');
  if (guard instanceof NextResponse) return guard;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'PDF is larger than 10MB' }, { status: 400 });

  try {
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    // No text at all usually means a scanned (image-only) PDF: the user types the fields in.
    return NextResponse.json({ parsed: parseBookingText(text), textFound: text.trim().length > 0 });
  } catch (err) {
    return NextResponse.json({ error: `Could not read the PDF: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
}
