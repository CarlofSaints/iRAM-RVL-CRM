/**
 * Resolve which clients a user is allowed to see data for.
 *
 * Used by BOTH server-side API handlers (to filter dashboard queries) and
 * client-side UI (to gate lists / dropdowns / charts). Keep this pure — no
 * I/O — so it can run in both environments.
 *
 * Rules:
 *   1. If the user has the `view_all_clients` permission → full access.
 *      (Super Admin has this by default via the seed.)
 *   2. If the user's role is `customer` and they have a `linkedClientId` →
 *      they see exactly that one client. This preserves the legacy single-
 *      client binding for customer accounts.
 *   3. Otherwise → they see whatever is in `assignedClientIds` (may be empty).
 */

export interface ClientScope {
  /** True when the user can see every client (no filtering needed). */
  all: boolean;
  /** Explicit list of allowed client IDs when `all` is false. */
  ids: string[];
}

export interface ClientScopeInput {
  permissions: string[] | undefined;
  role: string;
  linkedClientId?: string;
  assignedClientIds?: string[];
}

export function clientScopeFor(input: ClientScopeInput): ClientScope {
  const perms = input.permissions ?? [];
  if (perms.includes('view_all_clients')) {
    return { all: true, ids: [] };
  }
  if (input.role === 'customer' && input.linkedClientId) {
    return { all: false, ids: [input.linkedClientId] };
  }
  return { all: false, ids: input.assignedClientIds ?? [] };
}

/**
 * Given a scope and the full list of client IDs, return the actual IDs the
 * user should see. Handy when callers already have the full list.
 */
export function filterClientIdsByScope(scope: ClientScope, allClientIds: string[]): string[] {
  if (scope.all) return allClientIds;
  const allowed = new Set(scope.ids);
  return allClientIds.filter(id => allowed.has(id));
}
