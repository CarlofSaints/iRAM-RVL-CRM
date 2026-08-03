/**
 * Server-side glue for warehouse scoping.
 *
 * `lib/warehouseScope.ts` is pure so it can run in the browser; this file does
 * the blob reads and hands API routes a ready-made { scope, resolve } pair.
 *
 * Enforcement rule for every route: NEVER trust the caller's session payload —
 * sessions live in localStorage and the only thing the server gets is an
 * `x-user-id` header. Always re-read the user from the blob store, which is
 * what `resolveWarehouseAccess` does.
 */

import { NextResponse } from 'next/server';
import { loadControl } from '@/lib/controlData';
import { loadUsers, type User } from '@/lib/userData';
import {
  makeWarehouseResolver,
  warehouseScopeFor,
  isWarehouseAllowed,
  scopeLabel,
  type WarehouseRecord,
  type WarehouseScope,
} from '@/lib/warehouseScope';

export interface WarehouseAccess {
  scope: WarehouseScope;
  resolve: (raw: string | undefined | null) => string | null;
  warehouses: WarehouseRecord[];
  user: User | undefined;
}

/**
 * Load the caller's warehouse scope plus a resolver bound to the current
 * warehouse masterfile.
 */
export async function resolveWarehouseAccess(userId: string): Promise<WarehouseAccess> {
  const [users, warehouses] = await Promise.all([
    loadUsers(),
    loadControl<WarehouseRecord>('warehouses'),
  ]);
  const user = users.find(u => u.id === userId);
  const scope = warehouseScopeFor(
    { role: user?.role ?? '', assignedWarehouseIds: user?.assignedWarehouseIds },
    warehouses,
  );
  return { scope, resolve: makeWarehouseResolver(warehouses), warehouses, user };
}

/**
 * Action guard. Returns a 403 NextResponse when ANY of the supplied warehouse
 * values sits outside the caller's scope, otherwise null.
 *
 * Pass every warehouse involved in the action (a multi-slip release touches
 * several) — a partial check would let a mixed batch through.
 */
export function denyIfOutOfScope(
  access: Pick<WarehouseAccess, 'scope' | 'resolve'>,
  rawWarehouses: Array<string | undefined | null>,
  actionLabel: string,
): NextResponse | null {
  if (access.scope.all) return null;

  const blocked = rawWarehouses.filter(w => !isWarehouseAllowed(access.scope, w, access.resolve));
  if (blocked.length === 0) return null;

  const offending = Array.from(new Set(blocked.map(w => (w ?? '').trim() || '(no warehouse)')));
  return NextResponse.json(
    {
      error: `You do not have access to ${offending.join(', ')}. ` +
        `Your access is limited to ${scopeLabel(access.scope)}. ${actionLabel} was not performed.`,
    },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
}
