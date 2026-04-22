// Dynamic roles & permissions.
// Role IDs + permission keys are no longer hardcoded unions — they live in Vercel Blob
// (roles.json, permissions.json) and can be edited by Super Admin.
//
// This file defines:
//   - Types (Role, PermissionDef)
//   - Seed/default constants used by /api/seed
//   - hasPermission(perms, key) — pure array-contains check on the session's resolved permissions

export type Permission = string;

export interface Role {
  id: string;
  name: string;
  description: string;
  permissionKeys: string[];
  isSystem: boolean;
  createdAt: string;
}

export interface PermissionDef {
  key: string;
  name: string;
  description: string;
  category: string;
  isSystem: boolean;
  createdAt: string;
}

/**
 * System-seeded permissions. Cannot be deleted via UI. `isSystem: true` flag is
 * set when seeded; newer user-created perms have `isSystem: false`.
 */
export const DEFAULT_PERMISSIONS: Array<Omit<PermissionDef, 'createdAt' | 'isSystem'>> = [
  { key: 'view_dashboard', name: 'View Dashboard', description: 'View main dashboard', category: 'Dashboard' },
  { key: 'view_dashboard_scoped', name: 'View Dashboard (Scoped)', description: 'View dashboard limited to linked client', category: 'Dashboard' },
  { key: 'view_all_clients', name: 'View All Clients', description: 'See data for every client — bypasses per-user client assignments', category: 'Dashboard' },
  { key: 'manage_users', name: 'Manage Users', description: 'Add / edit / remove users', category: 'Admin' },
  { key: 'manage_roles', name: 'Manage Roles & Permissions', description: 'Add / edit / remove roles & permissions', category: 'Admin' },
  { key: 'manage_clients', name: 'Manage Clients / Suppliers', description: 'Manage clients/suppliers masterfile', category: 'Control Centre' },
  { key: 'manage_stores', name: 'Manage Stores', description: 'Manage stores masterfile', category: 'Control Centre' },
  { key: 'manage_products', name: 'Manage Products', description: 'Manage products masterfile', category: 'Control Centre' },
  { key: 'manage_reps', name: 'Manage Reps', description: 'Manage reps masterfile', category: 'Control Centre' },
  { key: 'manage_warehouses', name: 'Manage Warehouses', description: 'Manage warehouses masterfile', category: 'Control Centre' },
  { key: 'import_excel', name: 'Import Excel', description: 'Upload Excel files to control masterfiles', category: 'Control Centre' },
  { key: 'view_aged_stock', name: 'View Aged Stock', description: 'View the aged stock dashboard (scoped to assigned clients)', category: 'Aged Stock' },
  { key: 'load_aged_stock', name: 'Load Aged Stock', description: 'Upload & commit aged stock lists', category: 'Aged Stock' },
  { key: 'manage_pick_slips', name: 'Manage Pick Slips', description: 'Edit, send, and delete pick slips', category: 'Aged Stock' },
  { key: 'receipt_stock', name: 'Receipt Stock', description: 'Receipt aged stock into warehouses via box scanning', category: 'Aged Stock' },
  { key: 'scan_stock', name: 'Scan Stock', description: 'Scan picking slips and book stock into warehouses', category: 'Aged Stock' },
];

/**
 * System-seeded roles. Role IDs are stable identifiers used on users. Cannot be
 * deleted, but their permissionKeys can be edited by Super Admin.
 */
export const DEFAULT_ROLES: Array<Omit<Role, 'createdAt' | 'isSystem'>> = [
  {
    id: 'super-admin',
    name: 'Super Admin',
    description: 'Full platform access including role & permission management',
    permissionKeys: DEFAULT_PERMISSIONS.map(p => p.key),
  },
  {
    id: 'rvl-manager',
    name: 'RVL Manager',
    description: 'Operations lead — manages all control files and imports data',
    permissionKeys: [
      'view_dashboard',
      'manage_clients',
      'manage_stores',
      'manage_products',
      'manage_reps',
      'manage_warehouses',
      'import_excel',
      'view_aged_stock',
      'load_aged_stock',
      'manage_pick_slips',
      'receipt_stock',
      'scan_stock',
    ],
  },
  {
    id: 'rep',
    name: 'Rep',
    description: 'Field representative — read-only dashboard access',
    permissionKeys: ['view_dashboard', 'view_aged_stock', 'scan_stock'],
  },
  {
    id: 'customer',
    name: 'Customer',
    description: 'External client user — scoped dashboard tied to their linked client record',
    permissionKeys: ['view_dashboard_scoped'],
  },
];

/**
 * Map of legacy role strings → new role IDs. Used by seed migration only.
 */
export const LEGACY_ROLE_MIGRATION: Record<string, string> = {
  'super-user': 'super-admin',
  'supervisor': 'rvl-manager',
  'admin': 'rvl-manager',
};

/**
 * Pure check against the session's already-resolved permission list.
 */
export function hasPermission(perms: string[] | undefined, key: string): boolean {
  return !!perms && perms.includes(key);
}
