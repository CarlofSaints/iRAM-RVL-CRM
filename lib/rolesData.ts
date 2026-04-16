import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Role, PermissionDef } from './roles';
import { loadUsers } from './userData';

/**
 * Blob-backed CRUD for roles + permissions.
 * NO module-level cache — multi-container serverless safety.
 * Mirrors the controlData.ts pattern.
 */

const ROLES_KEY = 'roles.json';
const PERMISSIONS_KEY = 'permissions.json';

async function loadJsonArray<T>(key: string, localName: string): Promise<T[]> {
  if (!process.env.VERCEL) {
    const localFile = path.join(process.cwd(), 'data', localName);
    try {
      if (fs.existsSync(localFile)) {
        return JSON.parse(fs.readFileSync(localFile, 'utf-8')) as T[];
      }
    } catch { /* empty */ }
    return [];
  }

  try {
    const result = await get(key, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as T[];
    }
  } catch (err) {
    console.error(`[rolesData] Blob read failed for ${key}:`, err instanceof Error ? err.message : err);
  }
  return [];
}

async function saveJsonArray<T>(key: string, localName: string, items: T[]): Promise<void> {
  const json = JSON.stringify(items, null, 2);

  try {
    await put(key, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist ${key} to Vercel Blob: ${msg}`);
  }

  try {
    const localFile = path.join(process.cwd(), 'data', localName);
    const dir = path.dirname(localFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localFile, json);
  } catch {
    // Vercel read-only FS — expected
  }
}

export async function loadRoles(): Promise<Role[]> {
  return loadJsonArray<Role>(ROLES_KEY, 'roles.json');
}

export async function saveRoles(roles: Role[]): Promise<void> {
  return saveJsonArray(ROLES_KEY, 'roles.json', roles);
}

export async function loadPermissions(): Promise<PermissionDef[]> {
  return loadJsonArray<PermissionDef>(PERMISSIONS_KEY, 'permissions.json');
}

export async function savePermissions(perms: PermissionDef[]): Promise<void> {
  return saveJsonArray(PERMISSIONS_KEY, 'permissions.json', perms);
}

/**
 * Given a role ID, return the resolved permission keys for that role.
 * Returns [] if the role ID is unknown.
 */
export async function resolvePermissionsForRole(roleId: string): Promise<string[]> {
  const roles = await loadRoles();
  const role = roles.find(r => r.id === roleId);
  return role?.permissionKeys ?? [];
}

/**
 * Server-side guard. Reads `x-user-id` header, resolves the user's role → permissions,
 * and returns either:
 *   - { ok: true, userId, permissions }  on success
 *   - a NextResponse with 401/403 error  on failure
 *
 * Usage:
 *   const guard = await requirePermission(req, 'manage_users');
 *   if (guard instanceof NextResponse) return guard;
 *   // guard.permissions is available here
 */
export async function requirePermission(
  req: NextRequest,
  key: string
): Promise<NextResponse | { ok: true; userId: string; permissions: string[] }> {
  const userId = req.headers.get('x-user-id');
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const users = await loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const permissions = await resolvePermissionsForRole(user.role);
  if (!permissions.includes(key)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return { ok: true, userId, permissions };
}

/**
 * Lighter guard — just verifies the caller is a known user. Returns the user's
 * permissions for convenience. Used on GET endpoints where we want any logged-in
 * user to read but still want to know who they are.
 */
export async function requireLogin(
  req: NextRequest
): Promise<NextResponse | { ok: true; userId: string; permissions: string[] }> {
  const userId = req.headers.get('x-user-id');
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const users = await loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }
  const permissions = await resolvePermissionsForRole(user.role);
  return { ok: true, userId, permissions };
}
