'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function HelpButton() {
  const pathname = usePathname();
  // Don't show on the guide page itself
  if (pathname === '/guide') return null;

  return (
    <Link
      href="/guide"
      title="User Guide"
      className="fixed bottom-6 right-6 z-50 w-11 h-11 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg hover:bg-[var(--color-primary-dark)] transition-colors text-lg font-bold"
    >
      ?
    </Link>
  );
}
