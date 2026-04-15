export type Role = 'super-user' | 'supervisor' | 'admin';

export const ROLE_HIERARCHY: Role[] = ['admin', 'supervisor', 'super-user'];

export type Permission =
  | 'manage_users'
  | 'import_aged_stock'
  | 'manage_control_files'
  | 'send_picking_lists'
  | 'capture_warehouse_receipts'
  | 'capture_upliftment'
  | 'print_reports'
  | 'warehouse_dispatch';

const PERMISSIONS: Record<Permission, Role[]> = {
  manage_users: ['super-user'],
  import_aged_stock: ['super-user'],
  manage_control_files: ['super-user', 'supervisor', 'admin'],
  send_picking_lists: ['super-user', 'supervisor'],
  capture_warehouse_receipts: ['super-user', 'supervisor'],
  capture_upliftment: ['super-user', 'supervisor', 'admin'],
  print_reports: ['super-user', 'supervisor'],
  warehouse_dispatch: ['super-user', 'supervisor'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission]?.includes(role) ?? false;
}

export function hasMinRole(role: Role, minRole: Role): boolean {
  return ROLE_HIERARCHY.indexOf(role) >= ROLE_HIERARCHY.indexOf(minRole);
}

export const ROLE_LABELS: Record<Role, string> = {
  'super-user': 'Super User',
  'supervisor': 'Supervisor',
  'admin': 'Admin',
};
