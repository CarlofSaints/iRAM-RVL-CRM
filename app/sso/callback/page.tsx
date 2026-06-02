import { Suspense } from 'react';
import SSOCallbackClient from './SSOCallbackClient';

export const dynamic = 'force-dynamic';

export default function SSOCallbackPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-400 text-sm">Signing in...</div></div>}>
      <SSOCallbackClient />
    </Suspense>
  );
}
