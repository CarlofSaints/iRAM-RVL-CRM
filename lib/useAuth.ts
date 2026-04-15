'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Role, hasMinRole } from './roles';

export interface Session {
  id: string;
  name: string;
  surname: string;
  email: string;
  role: Role;
}

const SESSION_KEY = 'rvl_session';

export function useAuth(minRole: Role = 'admin') {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      router.replace('/login');
      return;
    }
    try {
      const s: Session = JSON.parse(raw);
      if (!hasMinRole(s.role, minRole)) {
        router.replace('/dashboard');
        return;
      }
      setSession(s);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  }, [router, minRole]);

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    router.push('/login');
  }

  return { session, loading, logout };
}
