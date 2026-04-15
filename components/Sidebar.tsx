'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Image from 'next/image';
import { Session } from '@/lib/useAuth';
import { Role, hasMinRole, hasPermission } from '@/lib/roles';

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
  const [controlOpen, setControlOpen] = useState(pathname.startsWith('/control-centre'));
  const role = session.role;

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

      {/* User info */}
      <div className="px-5 py-3 border-b border-white/10">
        <div className="text-white text-sm font-medium">{session.name} {session.surname}</div>
        <div className="text-gray-400 text-xs">{session.role === 'super-user' ? 'Super User' : session.role === 'supervisor' ? 'Supervisor' : 'Admin'}</div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-1 overflow-y-auto">
        <NavLink href="/dashboard" label="Dashboard" active={pathname === '/dashboard'} />

        {/* Control Centre — all roles */}
        {hasPermission(role, 'manage_control_files') && (
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
                <SubNavLink href="/control-centre/clients" label="Clients / Suppliers" active={pathname === '/control-centre/clients'} />
                <SubNavLink href="/control-centre/stores" label="Stores" active={pathname === '/control-centre/stores'} />
                <SubNavLink href="/control-centre/products" label="Products" active={pathname === '/control-centre/products'} />
                <SubNavLink href="/control-centre/reps" label="Reps" active={pathname === '/control-centre/reps'} />
                <SubNavLink href="/control-centre/warehouses" label="Warehouses" active={pathname === '/control-centre/warehouses'} />
              </div>
            )}
          </>
        )}

        {/* Admin — super-user only */}
        {hasMinRole(role, 'super-user') && (
          <NavLink href="/admin/users" label="User Management" active={pathname === '/admin/users'} />
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
