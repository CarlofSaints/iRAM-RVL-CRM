'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Session, avatarSrcFor } from '@/lib/useAuth';
import Logo from '@/components/Logo';
import HelpButton from '@/components/HelpButton';

const COLLAPSE_KEY = 'rvl_sidebar_collapsed';

interface SidebarProps {
  session: Session;
  onLogout: () => void;
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`block px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        active
          ? 'bg-[var(--color-primary)] text-white'
          : 'text-gray-300 hover:bg-white/10 hover:text-white'
      }`}
    >
      {label}
    </Link>
  );
}

function SubNavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`block pl-8 pr-4 py-2 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-white/15 text-white font-medium'
          : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
      }`}
    >
      {label}
    </Link>
  );
}

export default function Sidebar({ session, onLogout }: SidebarProps) {
  const pathname = usePathname();
  const perms = session.permissions ?? [];
  const has = (k: string) => perms.includes(k);

  // Per-link permission map for Control Centre children
  const controlLinks: Array<{ href: string; label: string; perm: string }> = [
    { href: '/control-centre/clients', label: 'Clients / Suppliers', perm: 'manage_clients' },
    { href: '/control-centre/stores', label: 'Stores', perm: 'manage_stores' },
    { href: '/control-centre/products', label: 'Products', perm: 'manage_products' },
    { href: '/control-centre/reps', label: 'Reps', perm: 'manage_reps' },
    { href: '/control-centre/warehouses', label: 'Warehouses', perm: 'manage_warehouses' },
    { href: '/control-centre/channels', label: 'Channels', perm: 'manage_stores' },
  ];
  const visibleControlLinks = controlLinks.filter(l => has(l.perm));
  const showControlSection = visibleControlLinks.length > 0;

  // Aged Stock — Dashboard + Load. The dashboard perm is the cheaper one;
  // users with load_aged_stock always get view_aged_stock by convention.
  const agedStockLinks: Array<{ href: string; label: string; perm: string }> = [
    { href: '/aged-stock', label: 'Dashboard', perm: 'view_aged_stock' },
    { href: '/aged-stock/load', label: 'Load Aged Stock', perm: 'load_aged_stock' },
    { href: '/aged-stock/picking-slips', label: 'Picking Slips', perm: 'view_aged_stock' },
    { href: '/aged-stock/stickers', label: 'Sticker Labels', perm: 'view_aged_stock' },
    { href: '/aged-stock/scan', label: 'Scan to Receive/Release', perm: 'scan_stock' },
    { href: '/aged-stock/receipts', label: 'Receive/Release Stock', perm: 'receipt_stock' },
  ];
  const visibleAgedStockLinks = agedStockLinks.filter(l => has(l.perm));
  const showAgedStockSection = visibleAgedStockLinks.length > 0;

  const [controlOpen, setControlOpen] = useState(pathname.startsWith('/control-centre'));
  const [agedStockOpen, setAgedStockOpen] = useState(pathname.startsWith('/aged-stock'));
  const [collapsed, setCollapsed] = useState(false);

  // Hydrate collapsed state from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  // Sync body class + persist whenever collapsed changes
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* empty */ }
  }, [collapsed]);

  return (
    <>
      {/* Floating burger — only visible when collapsed */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Open menu"
          title="Open menu"
          className="fixed top-3 left-3 z-50 w-9 h-9 rounded-md bg-white text-gray-600 border border-gray-200 flex items-center justify-center shadow-sm hover:bg-gray-50 hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      <aside
        className={`w-64 bg-[var(--color-charcoal)] min-h-screen flex flex-col fixed left-0 top-0 z-40 transition-transform duration-200 ${
          collapsed ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
      {/* Logo / Brand + collapse button */}
      <div className="px-5 py-5 border-b border-white/10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Logo size={36} light />
        </div>
        <button
          onClick={() => setCollapsed(true)}
          aria-label="Collapse menu"
          className="text-gray-400 hover:text-white p-1.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* User info — clickable to /account */}
      <Link
        href="/account"
        className={`px-5 py-3 border-b border-white/10 flex items-center gap-3 transition-colors ${
          pathname === '/account' ? 'bg-white/10' : 'hover:bg-white/5'
        }`}
      >
        {avatarSrcFor(session.id, session.avatarUpdatedAt) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarSrcFor(session.id, session.avatarUpdatedAt)!}
            alt={session.name}
            className="w-10 h-10 rounded-full object-cover border border-white/20 flex-shrink-0"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center font-bold text-sm flex-shrink-0">
            {`${(session.name?.[0] ?? '').toUpperCase()}${(session.surname?.[0] ?? '').toUpperCase()}` || '?'}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-white text-sm font-medium truncate">{session.name} {session.surname}</div>
          <div className="text-gray-400 text-xs truncate">{session.roleName ?? session.role}</div>
        </div>
      </Link>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-1 overflow-y-auto">
        <NavLink href="/dashboard" label="Dashboard" active={pathname === '/dashboard'} />

        {/* Control Centre — only links the user has perm for */}
        {showControlSection && (
          <>
            <button
              onClick={() => setControlOpen(v => !v)}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                pathname.startsWith('/control-centre')
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              Control Centre
              <svg className={`w-4 h-4 transition-transform ${controlOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {controlOpen && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                <SubNavLink href="/control-centre" label="Overview" active={pathname === '/control-centre'} />
                {visibleControlLinks.map(l => (
                  <SubNavLink key={l.href} href={l.href} label={l.label} active={pathname === l.href} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Aged Stock — only when user has at least one relevant perm */}
        {showAgedStockSection && (
          <>
            <button
              onClick={() => setAgedStockOpen(v => !v)}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                pathname.startsWith('/aged-stock')
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              Aged Stock
              <svg className={`w-4 h-4 transition-transform ${agedStockOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {agedStockOpen && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {visibleAgedStockLinks.map(l => (
                  <SubNavLink key={l.href} href={l.href} label={l.label} active={pathname === l.href} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Admin section */}
        {has('manage_users') && (
          <NavLink href="/admin/users" label="User Management" active={pathname === '/admin/users'} />
        )}
        {has('manage_roles') && (
          <NavLink href="/admin/roles" label="Roles & Permissions" active={pathname === '/admin/roles'} />
        )}
        {has('manage_users') && (
          <NavLink href="/admin/audit-log" label="Audit Log" active={pathname === '/admin/audit-log'} />
        )}
      </nav>

      {/* User Guide + Logout */}
      <div className="px-3 py-4 border-t border-white/10 flex flex-col gap-1">
        {has('view_dashboard') && (
          <NavLink href="/guide" label="User Guide" active={pathname === '/guide'} />
        )}
        <button
          onClick={onLogout}
          className="w-full px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/10 hover:text-white transition-colors text-left"
        >
          Sign Out
        </button>
      </div>
      </aside>
      <HelpButton />
    </>
  );
}
