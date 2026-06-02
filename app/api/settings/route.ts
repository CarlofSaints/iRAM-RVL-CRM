import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, type AppSettings } from '@/lib/settingsData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/settings — Read app settings.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  const settings = await loadSettings();
  return NextResponse.json(settings, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * PUT /api/settings — Update app settings.
 */
export async function PUT(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  let body: Partial<AppSettings>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const current = await loadSettings();

  // Merge sticker settings
  if (body.sticker) {
    const w = typeof body.sticker.widthMm === 'number' ? body.sticker.widthMm : current.sticker.widthMm;
    const h = typeof body.sticker.heightMm === 'number' ? body.sticker.heightMm : current.sticker.heightMm;
    const layout = body.sticker.layout === 'roll' || body.sticker.layout === 'a4sheet'
      ? body.sticker.layout
      : current.sticker.layout;

    if (w < 20 || w > 210 || h < 20 || h > 297) {
      return NextResponse.json(
        { error: 'Sticker dimensions must be between 20mm and A4 size (210x297mm)' },
        { status: 400 },
      );
    }

    const marginTop = typeof body.sticker.marginTop === 'number' ? Math.max(0, body.sticker.marginTop) : current.sticker.marginTop;
    const marginBottom = typeof body.sticker.marginBottom === 'number' ? Math.max(0, body.sticker.marginBottom) : current.sticker.marginBottom;
    const marginLeft = typeof body.sticker.marginLeft === 'number' ? Math.max(0, body.sticker.marginLeft) : current.sticker.marginLeft;
    const marginRight = typeof body.sticker.marginRight === 'number' ? Math.max(0, body.sticker.marginRight) : current.sticker.marginRight;

    current.sticker = { widthMm: w, heightMm: h, layout, marginTop, marginBottom, marginLeft, marginRight };
  }

  await saveSettings(current);
  return NextResponse.json(current);
}
