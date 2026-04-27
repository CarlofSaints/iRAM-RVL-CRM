'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface Session {
  id: string;
  name: string;
  surname: string;
  email: string;
  /** Role ID (from roles.json). */
  role: string;
  /** Human-readable role name, resolved at login. */
  roleName: string;
  /** Resolved permission keys, resolved at login. */
  permissions: string[];
  /** Customer users only — references the linked clients/suppliers record. */
  linkedClientId?: string;
  /** Clients this user has been assigned to (non-customer roles). Used by the
   *  dashboard / data views to scope what they see. Super Admins ignore this
   *  because they have the `view_all_clients` permission. */
  assignedClientIds?: string[];
  /** ISO timestamp of last avatar change — when set, avatar is available via the proxy URL. */
  avatarUpdatedAt?: string;
  /** Current subscription tier. Defaults to 'standard'. */
  subscriptionTier?: 'standard' | 'pro';
  /** Permission keys flagged as proOnly — used by the client to gate Pro features. */
  proPermissions?: string[];
}

/**
 * Build the avatar image URL for a given user. Returns undefined when no avatar
 * has been uploaded. Uses /api/account/avatar/[userId] proxy + cache-busting timestamp.
 */
export function avatarSrcFor(userId: string, updatedAt: string | undefined | null): string | undefined {
  if (!updatedAt) return undefined;
  return `/api/account/avatar/${encodeURIComponent(userId)}?t=${encodeURIComponent(updatedAt)}`;
}

const SESSION_KEY = 'rvl_session';

/**
 * Client-side auth guard.
 *
 * @param requiredPermission  If provided, user is redirected to /dashboard when
 *                            they don't have it. When omitted, any logged-in user passes.
 */
export function useAuth(requiredPermission?: string) {
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
      if (requiredPermission && !(s.permissions ?? []).includes(requiredPermission)) {
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
  }, [router, requiredPermission]);

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    router.push('/login');
  }

  return { session, loading, logout };
}

/**
 * Patch the current session in localStorage with new fields and dispatch a
 * 'storage' event so other tabs (and the same tab if listening) can react.
 * Returns the updated Session, or null if no session was loaded.
 */
export function updateSession(patch: Partial<Session>): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const current = JSON.parse(raw) as Session;
    const next = { ...current, ...patch };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

/**
 * Drop-in fetch wrapper that attaches `x-user-id` from the current session.
 * Use on all client-side calls to APIs that enforce requirePermission / requireLogin.
 */
export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  let userId = '';
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Session>;
        userId = s?.id ?? '';
      }
    } catch { /* ignore */ }
  }

  const headers = new Headers(init.headers);
  if (userId) headers.set('x-user-id', userId);

  return fetch(input, { ...init, headers });
}
