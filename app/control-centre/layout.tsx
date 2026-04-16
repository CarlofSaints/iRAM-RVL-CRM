'use client';

import { useAuth } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';

export default function ControlCentreLayout({ children }: { children: React.ReactNode }) {
  // Any logged-in user. Each child page enforces its own specific permission.
  const { session, loading, logout } = useAuth();

  if (loading || !session) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      <main className="ml-64 px-8 py-8">
        {children}
      </main>
    </div>
  );
}
