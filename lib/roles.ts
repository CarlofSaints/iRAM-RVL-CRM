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
  /** When true, this permission is gated behind the Pro subscription tier (customer role only). */
  proOnly?: boolean;
  createdAt: string;
}

/**
 * System-seeded permissions. Cannot be deleted via UI. `isSystem: true` flag is
 * set when seeded; newer user-created perms have `isSystem: false`.
 */
export const DEFAULT_PERMISSIONS: Array<Omit<PermissionDef, 'createdAt' | 'isSystem'>> = [
  { key: 'view_dashboard', name: 'View Dashboard', description: 'View main dashboard', category: 'Dashboard', proOnly: false },
  { key: 'view_dashboard_scoped', name: 'View Dashboard (Assigned Clients Only)', description: 'View dashboard limited to assigned clients only', category: 'Dashboard', proOnly: false },
  { key: 'view_all_clients', name: 'View All Clients', description: 'See data for every client — bypasses per-user client assignments', category: 'Dashboard', proOnly: false },
  { key: 'export_excel', name: 'Export to Excel', description: 'Download dashboard grids as Excel files', category: 'Dashboard', proOnly: true },
  { key: 'manage_users', name: 'Manage Users', description: 'Add / edit / remove users', category: 'Admin', proOnly: false },
  { key: 'manage_roles', name: 'Manage Roles & Permissions', description: 'Add / edit / remove roles & permissions', category: 'Admin', proOnly: false },
  { key: 'manage_clients', name: 'Manage Clients / Suppliers', description: 'Manage clients/suppliers masterfile', category: 'Control Centre', proOnly: false },
  { key: 'manage_stores', name: 'Manage Stores', description: 'Manage stores masterfile', category: 'Control Centre', proOnly: false },
  { key: 'manage_products', name: 'Manage Products', description: 'Manage products masterfile', category: 'Control Centre', proOnly: false },
  { key: 'manage_reps', name: 'Manage Reps', description: 'Manage reps masterfile', category: 'Control Centre', proOnly: false },
  { key: 'manage_warehouses', name: 'Manage Warehouses', description: 'Manage warehouses masterfile', category: 'Control Centre', proOnly: false },
  { key: 'import_excel', name: 'Import Excel', description: 'Upload Excel files to control masterfiles', category: 'Control Centre', proOnly: false },
  { key: 'view_aged_stock', name: 'View Aged Stock', description: 'View the aged stock dashboard (limited to assigned clients)', category: 'Aged Stock', proOnly: false },
  { key: 'load_aged_stock', name: 'Load Aged Stock', description: 'Upload & commit aged stock lists', category: 'Aged Stock', proOnly: false },
  { key: 'manage_pick_slips', name: 'Manage Pick Slips', description: 'Edit, send, and delete pick slips', category: 'Aged Stock', proOnly: false },
  { key: 'receipt_stock', name: 'Receipt Stock', description: 'Receipt aged stock into warehouses via box scanning', category: 'Aged Stock', proOnly: false },
  { key: 'scan_stock', name: 'Scan Stock', description: 'Scan picking slips and book stock into warehouses', category: 'Aged Stock', proOnly: false },
  { key: 'clear_data', name: 'Clear Data', description: 'Permanently delete aged stock loads, pick slips, stickers, and audit logs', category: 'Admin', proOnly: false },
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
    description: 'External client user — dashboard limited to their assigned client record',
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
