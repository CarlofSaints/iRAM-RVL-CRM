/**
 * Shared server-side guard for the Promotional Material APIs.
 *
 * Every promo route needs the same four things: the permission check, the
 * caller's user record (for their name/email on the audit trail and the
 * emails), the client list, and which of those clients they may touch. Doing it
 * once here keeps the ten routes honest — a route that forgets to scope is a
 * route that leaks another client's kits.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from './rolesData';
import { loadUsers, type User } from './userData';
import { loadControl } from './controlData';
import { clientScopeFor, filterClientIdsByScope } from './clientScope';
import type { ClientWithLinks } from './spLinkData';

export interface PromoContext {
  me: User;
  permissions: string[];
  clients: ClientWithLinks[];
  /** Client ids the caller may see. */
  visibleClientIds: Set<string>;
  /** True when the caller may see/act on this client. */
  canSeeClient: (clientId: string) => boolean;
  clientName: (clientId: string) => string;
}

export async function promoContext(
  req: NextRequest,
  permission: string,
): Promise<NextResponse | PromoContext> {
  const guard = await requirePermission(req, permission);
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
  const visibleClientIds = new Set(filterClientIdsByScope(scope, clients.map(c => c.id)));
  const nameById = new Map(clients.map(c => [c.id, c.name] as const));

  return {
    me,
    permissions: guard.permissions,
    clients,
    visibleClientIds,
    canSeeClient: (clientId: string) => visibleClientIds.has(clientId),
    clientName: (clientId: string) => nameById.get(clientId) ?? 'Unknown client',
  };
}

/** Display name for a user record, e.g. "Carl Dos Santos". */
export function fullName(u: { name?: string; surname?: string }): string {
  return [u.name, u.surname].filter(Boolean).join(' ').trim();
}
