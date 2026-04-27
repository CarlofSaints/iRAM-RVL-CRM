'use client';

import { useRouter } from 'next/navigation';

interface ProGateModalProps {
  open: boolean;
  onClose: () => void;
  /** Describe the feature the user tried to use, e.g. "export dashboard data to Excel" */
  feature: string;
}

export default function ProGateModal({ open, onClose, feature }: ProGateModalProps) {
  const router = useRouter();

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 text-center">
        {/* Lock icon */}
        <div className="mx-auto w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mb-4">
          <svg className="w-7 h-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>

        <h2 className="text-lg font-bold text-gray-900 mb-2">Upgrade to Pro</h2>
        <p className="text-sm text-gray-600 mb-5">
          To <strong>{feature}</strong>, upgrade to the Pro plan and unlock advanced reporting tools.
        </p>

        {/* Price */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-5">
          <div className="text-2xl font-bold text-gray-900">R189<span className="text-sm font-normal text-gray-500"> / month</span></div>
          <p className="text-xs text-gray-500 mt-1">Excel exports, email reports, advanced charts & more</p>
        </div>

        <div className="flex flex-col gap-2.5">
          <button
            onClick={() => { onClose(); router.push('/account?tab=billing'); }}
            className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-all"
          >
            Upgrade Now
          </button>
          <button
            onClick={onClose}
            className="w-full text-sm text-gray-500 hover:text-gray-700 px-5 py-2 transition-colors"
          >
            Maybe Later
          </button>
        </div>
      </div>
    </div>
  );
}
