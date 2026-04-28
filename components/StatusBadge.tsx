'use client';

import { useState, useRef, useEffect } from 'react';

export const STATUS_LABELS: Record<string, string> = {
  'generated': 'Generated',
  'sent': 'Sent',
  'booked': 'Booked',
  'captured': 'Captured',
  'in-transit': 'In Transit',
  'failed-release': 'Failed Release',
  'partial-release': 'Partial Release',
  'delivered': 'Delivered',
};

export const STATUS_COLORS: Record<string, string> = {
  'generated': 'bg-gray-100 text-gray-700',
  'sent': 'bg-blue-100 text-blue-700',
  'booked': 'bg-teal-100 text-teal-700',
  'captured': 'bg-green-100 text-green-700',
  'in-transit': 'bg-purple-100 text-purple-700',
  'failed-release': 'bg-red-100 text-red-700',
  'partial-release': 'bg-red-100 text-red-700',
  'delivered': 'bg-emerald-100 text-emerald-700',
};

export const STATUS_TOOLTIPS: Record<string, string> = {
  'generated': 'Aged stock has been loaded into the system and picking slip has been generated.',
  'sent': 'Pick slip has been sent to the rep via email.',
  'booked': 'Stock has been scanned into the iRam warehouse.',
  'captured': 'Pick slip has been captured with all non-collection reasons.',
  'in-transit': 'Stock is on its way from iRam Warehouse to customer.',
  'delivered': 'Stock has been delivered back to customer. Triggered by the signature on the QR code form.',
  'failed-release': 'The release code entered did not match. The release must be retried with the correct code.',
  'partial-release': 'Stock was partially released — box count mismatch overridden by a manager.',
};

interface StatusBadgeProps {
  status: string;
  showTooltip?: boolean;
}

export default function StatusBadge({ status, showTooltip = true }: StatusBadgeProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const tooltip = STATUS_TOOLTIPS[status];

  return (
    <span className="inline-flex items-center gap-1 relative" ref={ref}>
      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || 'bg-gray-100 text-gray-700'}`}>
        {STATUS_LABELS[status] || status}
      </span>
      {showTooltip && tooltip && (
        <>
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            className="w-4 h-4 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-[10px] font-bold hover:bg-gray-300 transition-colors shrink-0"
            aria-label={`Info about ${STATUS_LABELS[status] || status}`}
          >
            i
          </button>
          {open && (
            <div className="absolute left-0 bottom-full mb-1.5 z-50 w-60 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none whitespace-normal break-words leading-relaxed">
              {tooltip}
              <div className="absolute left-3 top-full w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[5px] border-t-gray-900" />
            </div>
          )}
        </>
      )}
    </span>
  );
}
