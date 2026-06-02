'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function SSOCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setError('Missing SSO token');
      return;
    }

    (async () => {
      try {
        const res = await fetch('/api/sso/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || 'SSO login failed');
          return;
        }

        // Store session in localStorage (rvl_session format)
        localStorage.setItem('rvl_session', JSON.stringify({
          id: data.id,
          name: data.name,
          surname: data.surname,
          email: data.email,
          role: data.role,
          roleName: data.roleName,
          permissions: data.permissions ?? [],
          linkedClientId: data.linkedClientId,
          avatarUpdatedAt: data.avatarUpdatedAt,
          subscriptionTier: data.subscriptionTier ?? 'standard',
        }));

        router.replace('/dashboard');
      } catch {
        setError('Network error during SSO login');
      }
    })();
  }, [searchParams, router]);

  if (error) {
    const hubUrl = process.env.NEXT_PUBLIC_IRAM_HUB_URL || 'https://iram-hub.vercel.app';
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm w-full bg-white rounded-xl shadow-lg p-8 text-center">
          <div className="text-red-500 text-4xl mb-4">!</div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">SSO Login Failed</h2>
          <p className="text-sm text-gray-600 mb-6">{error}</p>
          <a
            href={hubUrl}
            className="inline-block bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold py-2.5 px-6 rounded-lg transition-colors text-sm"
          >
            Back to iRam Hub
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-gray-400 text-sm">Signing in...</div>
    </div>
  );
}
