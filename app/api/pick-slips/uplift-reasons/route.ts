import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadSettings } from '@/lib/settingsData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pick-slips/uplift-reasons — the configured "unsuccessful upliftment"
 * reasons, for populating the Mark Unsuccessful dropdown. Gated by the same
 * permission as the action itself so it doesn't depend on warehouse perms.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  const settings = await loadSettings();
  return NextResponse.json(
    { reasons: settings.upliftFailureReasons },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
