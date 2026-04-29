import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { loadUsers, saveUsers, User } from '@/lib/userData';
import { loadControl, saveControl, ControlType } from '@/lib/controlData';
import { loadRoles, saveRoles, loadPermissions, savePermissions } from '@/lib/rolesData';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLES,
  LEGACY_ROLE_MIGRATION,
  type Role,
  type PermissionDef,
} from '@/lib/roles';

export const dynamic = 'force-dynamic';

interface Warehouse {
  id: string;
  name: string;
  code: string;
  region: string;
  createdAt: string;
}

export async function POST(req: NextRequest) {
  const { secret } = await req.json();
  if (secret !== process.env.SEED_SECRET && secret !== 'rvl-seed-2026') {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
  }

  const now = new Date().toISOString();

  // === Seed Permissions (idempotent) ===
  const permissions = await loadPermissions();
  let permissionsSeeded = 0;
  for (const p of DEFAULT_PERMISSIONS) {
    const existing = permissions.find(x => x.key === p.key);
    if (existing) {
      // Keep system permission name, description, category, proOnly in sync with code defaults
      let changed = false;
      if (existing.name !== p.name) { existing.name = p.name; changed = true; }
      if (existing.description !== p.description) { existing.description = p.description; changed = true; }
      if (existing.category !== p.category) { existing.category = p.category; changed = true; }
      if (existing.proOnly !== p.proOnly) { existing.proOnly = p.proOnly; changed = true; }
      if (changed) permissionsSeeded++;
      continue;
    }
    const perm: PermissionDef = { ...p, isSystem: true, createdAt: now };
    permissions.push(perm);
    permissionsSeeded++;
  }
  if (permissionsSeeded > 0) await savePermissions(permissions);

  // === Seed Roles (idempotent) ===
  const roles = await loadRoles();
  let rolesSeeded = 0;
  for (const r of DEFAULT_ROLES) {
    if (roles.find(x => x.id === r.id)) continue;
    const role: Role = { ...r, isSystem: true, createdAt: now };
    roles.push(role);
    rolesSeeded++;
  }

  // Migration: keep super-admin in sync with ALL DEFAULT_PERMISSIONS so new
  // system permissions (e.g. view_all_clients) propagate on re-seed.
  let rolesPatched = 0;
  const superAdmin = roles.find(r => r.id === 'super-admin');
  if (superAdmin) {
    const allKeys = DEFAULT_PERMISSIONS.map(p => p.key);
    const current = new Set(superAdmin.permissionKeys);
    const missing = allKeys.filter(k => !current.has(k));
    if (missing.length) {
      superAdmin.permissionKeys = [...superAdmin.permissionKeys, ...missing];
      rolesPatched++;
    }
  }

  if (rolesSeeded > 0 || rolesPatched > 0) await saveRoles(roles);

  // === Seed / Migrate Users ===
  const users = await loadUsers();

  // Migrate legacy role strings on existing users
  let usersMigrated = 0;
  for (const u of users) {
    const migrated = LEGACY_ROLE_MIGRATION[u.role];
    if (migrated) {
      u.role = migrated;
      usersMigrated++;
    }
  }

  const seedUsers: Array<{ name: string; surname: string; email: string; password: string }> = [
    { name: 'Carl', surname: 'Dos Santos', email: 'carl@outerjoin.co.za', password: 'rvl2026' },
    { name: 'Johann', surname: '', email: 'johann@iram.co.za', password: 'rvl2026' },
  ];

  let usersAdded = 0;
  for (const su of seedUsers) {
    if (users.find(u => u.email.toLowerCase() === su.email.toLowerCase())) continue;
    const user: User = {
      id: randomUUID(),
      name: su.name,
      surname: su.surname,
      email: su.email,
      password: await bcrypt.hash(su.password, 10),
      role: 'super-admin',
      forcePasswordChange: true,
      firstLoginAt: null,
      createdAt: now,
    };
    users.push(user);
    usersAdded++;
  }

  if (usersAdded > 0 || usersMigrated > 0) await saveUsers(users);

  // === Seed Warehouses ===
  const warehouses = await loadControl<Warehouse>('warehouses' as ControlType);
  const seedWarehouses = [
    { name: 'Gauteng', code: 'GAU', region: 'Gauteng' },
    { name: 'KwaZulu-Natal', code: 'KZN', region: 'KwaZulu-Natal' },
    { name: 'Western Cape', code: 'WC', region: 'Western Cape' },
    { name: 'Port Elizabeth', code: 'PE', region: 'Eastern Cape' },
  ];

  let warehousesAdded = 0;
  for (const sw of seedWarehouses) {
    if (warehouses.find(w => w.code === sw.code)) continue;
    warehouses.push({
      id: randomUUID(),
      name: sw.name,
      code: sw.code,
      region: sw.region,
      createdAt: now,
    });
    warehousesAdded++;
  }
  if (warehousesAdded > 0) await saveControl('warehouses' as ControlType, warehouses);

  return NextResponse.json({
    ok: true,
    permissionsSeeded,
    rolesSeeded,
    rolesPatched,
    usersAdded,
    usersMigrated,
    warehousesAdded,
    totals: {
      permissions: permissions.length,
      roles: roles.length,
      users: users.length,
      warehouses: warehouses.length,
    },
  });
}
