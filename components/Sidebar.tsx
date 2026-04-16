'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Image from 'next/image';
import { Session } from '@/lib/useAuth';

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
  ];
  const visibleControlLinks = controlLinks.filter(l => has(l.perm));
  const showControlSection = visibleControlLinks.length > 0;

  const [controlOpen, setControlOpen] = useState(pathname.startsWith('/control-centre'));

  return (
    <aside className="w-64 bg-[var(--color-charcoal)] min-h-screen flex flex-col fixed left-0 top-0 z-40">
      {/* Logo / Brand */}
      <div className="px-5 py-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <Image src="/iram-logo.png" alt="iRam" width={40} height={40} className="rounded" />
          <div>
            <div className="text-white font-bold text-sm tracking-wide">iRAM RVL</div>
            <div className="text-gray-400 text-xs">CRM</div>
          </div>
        </div>
      </div>

      {/* User info — clickable to /account */}
      <Link
        href="/account"
        className={`px-5 py-3 border-b border-white/10 flex items-center gap-3 transition-colors ${
          pathname === '/account' ? 'bg-white/10' : 'hover:bg-white/5'
        }`}
      >
        {session.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={session.avatarUrl}
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

        {/* Admin section */}
        {has('manage_users') && (
          <NavLink href="/admin/users" label="User Management" active={pathname === '/admin/users'} />
        )}
        {has('manage_roles') && (
          <NavLink href="/admin/roles" label="Roles & Permissions" active={pathname === '/admin/roles'} />
        )}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-white/10">
        <button
          onClick={onLogout}
          className="w-full px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/10 hover:text-white transition-colors text-left"
        >
          Sign Out
        </button>
      </div>
    </aside>
  );
}
