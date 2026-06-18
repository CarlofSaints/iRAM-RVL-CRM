import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import {
  loadSettings,
  saveSettings,
  normalizeSettings,
  type AppSettings,
  type StickerLayout,
  type StickerProfile,
} from '@/lib/settingsData';

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

/** Validate + clamp a single profile. Returns an error string or the clean profile. */
function cleanProfile(p: unknown, fallback: StickerProfile): { profile?: StickerProfile; error?: string } {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && !isNaN(v) ? v : d);
  const w = num(o.widthMm, fallback.widthMm);
  const h = num(o.heightMm, fallback.heightMm);
  if (w < 20 || w > 210 || h < 20 || h > 297) {
    return { error: 'Sticker dimensions must be between 20mm and A4 size (210x297mm)' };
  }
  return {
    profile: {
      widthMm: w,
      heightMm: h,
      gapMm: Math.max(0, num(o.gapMm, fallback.gapMm)),
      marginTop: Math.max(0, num(o.marginTop, fallback.marginTop)),
      marginBottom: Math.max(0, num(o.marginBottom, fallback.marginBottom)),
      marginLeft: Math.max(0, num(o.marginLeft, fallback.marginLeft)),
      marginRight: Math.max(0, num(o.marginRight, fallback.marginRight)),
    },
  };
}

/**
 * PUT /api/settings — Update app settings.
 *
 * Accepts the two-profile sticker shape. Each profile is merged + validated
 * against the current saved values, so partial updates are safe.
 */
export async function PUT(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  let body: Partial<AppSettings>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const current = await loadSettings();

  if (body.sticker) {
    const incoming = body.sticker;

    const rollRes = cleanProfile(incoming.roll, current.sticker.roll);
    if (rollRes.error) return NextResponse.json({ error: `Roll: ${rollRes.error}` }, { status: 400 });

    const a4Res = cleanProfile(incoming.a4sheet, current.sticker.a4sheet);
    if (a4Res.error) return NextResponse.json({ error: `A4 Sheet: ${a4Res.error}` }, { status: 400 });

    const defaultLayout: StickerLayout =
      incoming.defaultLayout === 'roll' || incoming.defaultLayout === 'a4sheet'
        ? incoming.defaultLayout
        : current.sticker.defaultLayout;

    current.sticker = {
      defaultLayout,
      roll: rollRes.profile!,
      a4sheet: a4Res.profile!,
    };
  }

  await saveSettings(normalizeSettings(current));
  return NextResponse.json(current);
}
