import { NextRequest, NextResponse } from 'next/server';
import { requireLogin } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { loadControl } from '@/lib/controlData';
import type { ClientWithLinks } from '@/lib/spLinkData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/aged-stock/clients — returns the minimal client list the caller is
 * allowed to see (id + name + vendor numbers). Used to populate the client
 * picker on the load page and the filter dropdown on the dashboard.
 */
export async function GET(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  const clients = await loadControl<ClientWithLinks>('clients');
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  const visibleIds = new Set(filterClientIdsByScope(scope, clients.map(c => c.id)));
  const visible = clients
    .filter(c => visibleIds.has(c.id))
    .map(c => ({
      id: c.id,
      name: c.name,
      vendorNumbers: c.vendorNumbers ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json(
    { clients: visible },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
