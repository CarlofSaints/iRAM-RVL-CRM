/**
 * Resolve which warehouses a user is allowed to see and act on.
 *
 * Mirrors `lib/clientScope.ts`, with ONE deliberate difference in the default:
 *
 *   Client scoping is fail-CLOSED  — no assignment = no data (guarded by the
 *                                    `view_all_clients` bypass permission).
 *   Warehouse scoping is fail-OPEN — no assignment = every warehouse.
 *
 * Why fail-open here: introducing a `view_all_warehouses` bypass permission
 * would need a re-seed, and /api/seed only back-fills new permissions onto the
 * super-admin role (existing rvl-manager / rep roles are skipped once they
 * exist). Every manager and rep would therefore land with no bypass AND no
 * assignment — i.e. locked out of the whole app the moment this deployed.
 * "Empty means unrestricted" keeps every existing user exactly as they are and
 * only restricts the users an admin explicitly ticks warehouses for.
 *
 * Consequence to be aware of: a NEW user created without warehouses ticked can
 * see every warehouse. That matches how the app behaved before this feature.
 *
 * Keep this module pure — no I/O — so it can run on the server (API guards) and
 * in the browser (UI gating).
 */

export interface WarehouseRecord {
  id: string;
  name: string;
  code: string;
  region?: string;
  createdAt?: string;
}

export interface WarehouseScope {
  /** True when the user may see every warehouse (no filtering needed). */
  all: boolean;
  /** Canonical warehouse CODES (upper-cased) the user may touch when `all` is false. */
  codes: string[];
  /** Warehouse names for the allowed codes — for building human-readable 403 messages. */
  names: string[];
}

export interface WarehouseScopeInput {
  role: string;
  assignedWarehouseIds?: string[];
}

const norm = (s: string | undefined | null): string => (s ?? '').toUpperCase().trim();

/**
 * Build a resolver that turns a raw, free-text warehouse value (a slip's
 * `warehouse` name, a store's `linkedWarehouse`, a code, whatever) into a
 * canonical warehouse code.
 *
 * This is the same match order the per-route copies in /api/pick-slips,
 * /api/dashboard/stats etc. already use — exact code, exact name, then a
 * conservative prefix match — but it reports failure instead of silently
 * echoing the input back.
 *
 * Returns `null` when the value matches no known warehouse. Callers MUST decide
 * what an unresolvable value means; see `isWarehouseAllowed`.
 */
export function makeWarehouseResolver(
  warehouses: WarehouseRecord[]
): (raw: string | undefined | null) => string | null {
  const codeSet = new Set(warehouses.map(w => norm(w.code)).filter(Boolean));
  const nameToCode = new Map<string, string>(
    warehouses
      .map(w => [norm(w.name), norm(w.code)] as [string, string])
      .filter(([n]) => !!n)
  );

  return function resolve(raw: string | undefined | null): string | null {
    const upper = norm(raw);
    if (!upper) return null;
    if (codeSet.has(upper)) return upper;

    const byName = nameToCode.get(upper);
    if (byName) return byName;

    for (const w of warehouses) {
      const wCode = norm(w.code);
      const wName = norm(w.name);
      if (wName && (wName.startsWith(upper) || upper.startsWith(wName))) return wCode;
      if (wCode && (wCode.startsWith(upper) || upper.startsWith(wCode))) return wCode;
    }
    return null;
  };
}

/**
 * Legacy-compatible resolver: falls back to the upper-cased input when nothing
 * matches, exactly like the inline copies scattered through the API routes.
 * Use this for DISPLAY/grouping. Use `makeWarehouseResolver` for access checks.
 */
export function makeLenientWarehouseResolver(
  warehouses: WarehouseRecord[]
): (raw: string | undefined | null) => string {
  const strict = makeWarehouseResolver(warehouses);
  return (raw) => strict(raw) ?? norm(raw);
}

/**
 * Build a user's warehouse scope.
 *
 * Rules:
 *   1. Super Admin → always unrestricted (mirrors "Super Admins see all clients
 *      regardless of assignment"). Prevents an admin locking themselves out.
 *   2. No / empty `assignedWarehouseIds` → unrestricted. See the file header.
 *   3. Otherwise → exactly the warehouses assigned, by canonical code.
 *
 * Assignments are stored as warehouse RECORD IDs and converted to codes here,
 * so renaming a warehouse does not silently change who can reach it.
 */
export function warehouseScopeFor(
  input: WarehouseScopeInput,
  warehouses: WarehouseRecord[]
): WarehouseScope {
  if (input.role === 'super-admin') return { all: true, codes: [], names: [] };

  const assigned = (input.assignedWarehouseIds ?? []).filter(Boolean);
  if (assigned.length === 0) return { all: true, codes: [], names: [] };

  const assignedSet = new Set(assigned);
  const matched = warehouses.filter(w => assignedSet.has(w.id));

  // Every assigned id is stale (warehouses deleted since assignment). Treating
  // that as "unrestricted" would silently undo the restriction, so scope to
  // nothing instead and let the admin fix the assignment.
  if (matched.length === 0) return { all: false, codes: [], names: [] };

  return {
    all: false,
    codes: matched.map(w => norm(w.code)).filter(Boolean),
    names: matched.map(w => w.name).filter(Boolean),
  };
}

/**
 * Is this raw warehouse value inside the scope?
 *
 * An UNRESOLVABLE value (a slip whose warehouse string matches no warehouse
 * record) is treated as OUT of scope for a restricted user. Hiding it is the
 * safe read; the alternative leaks other warehouses' work through typos. The
 * Control Centre diagnostic (/api/control/warehouses/unresolved) lists these so
 * they can be cleaned up rather than quietly hidden forever.
 */
export function isWarehouseAllowed(
  scope: WarehouseScope,
  raw: string | undefined | null,
  resolve: (raw: string | undefined | null) => string | null
): boolean {
  if (scope.all) return true;
  const code = resolve(raw);
  if (!code) return false;
  return scope.codes.includes(code);
}

/** Filter a list of records by a warehouse-bearing field. */
export function filterByWarehouseScope<T>(
  scope: WarehouseScope,
  items: T[],
  getWarehouse: (item: T) => string | undefined | null,
  resolve: (raw: string | undefined | null) => string | null
): T[] {
  if (scope.all) return items;
  return items.filter(item => isWarehouseAllowed(scope, getWarehouse(item), resolve));
}

/** Human-readable list of the warehouses a user is limited to — for 403 messages. */
export function scopeLabel(scope: WarehouseScope): string {
  if (scope.all) return 'all warehouses';
  if (scope.names.length === 0) return 'no warehouses';
  return scope.names.join(', ');
}
