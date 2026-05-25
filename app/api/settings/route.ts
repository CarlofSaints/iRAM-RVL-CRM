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

    current.sticker = { widthMm: w, heightMm: h, layout };
  }

  await saveSettings(current);
  return NextResponse.json(current);
}
