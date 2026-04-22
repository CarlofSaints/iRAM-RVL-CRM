import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getAuditEntries, getRecentMonths } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * GET /api/audit-log?month=YYYY-MM
 * Returns audit log entries for a given month. Super-admin only.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_users');
  if (guard instanceof NextResponse) return guard;

  const month = req.nextUrl.searchParams.get('month');
  const months = getRecentMonths();

  if (!month) {
    return NextResponse.json(
      { months, entries: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const entries = await getAuditEntries(month);

  return NextResponse.json(
    { months, entries },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
