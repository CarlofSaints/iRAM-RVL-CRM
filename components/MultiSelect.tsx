'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Checkbox dropdown for filtering a grid or report.
 *
 * The same dropdown had been hand-rolled in the Swap-Outs list, the Swap-Outs
 * import and the Reports batch picker, each with its own click-away handling
 * and its own idea of what "nothing selected" reads as. This is that pattern,
 * once — including the escape hatches the copies kept forgetting: Escape and
 * click-away both close it, and a long list gets a search box.
 */

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Second line under the label — counts, dates, vendor numbers. */
  hint?: string;
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  placeholder = 'All',
  searchAbove = 8,
  disabled,
  className = '',
  widthClass = 'min-w-[15rem]',
}: {
  label?: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Shown when nothing is ticked — i.e. what "no filter" means here. */
  placeholder?: string;
  /** Show the search box once there are at least this many options. */
  searchAbove?: number;
  disabled?: boolean;
  className?: string;
  widthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return options;
    return options.filter(
      (o) => `${o.label} ${o.hint ?? ''} ${o.value}`.toUpperCase().includes(q)
    );
  }, [options, query]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const summary = (() => {
    if (selected.size === 0) return placeholder;
    if (selected.size === 1) {
      const one = options.find((o) => selected.has(o.value));
      return one ? one.label : '1 selected';
    }
    return `${selected.size} selected`;
  })();

  return (
    <div className={`relative ${widthClass} ${className}`} ref={boxRef}>
      {label && <label className="block text-xs text-gray-600 mb-1">{label}</label>}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen((o) => !o); setQuery(''); }}
        className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm text-left bg-white flex items-center justify-between gap-2 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={`truncate ${selected.size ? 'text-gray-900' : 'text-gray-500'}`}>{summary}</span>
        <svg className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[16rem] bg-white border border-gray-200 rounded-md shadow-lg">
          {options.length >= searchAbove && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full px-3 py-2 border-b border-gray-100 text-sm outline-none"
            />
          )}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 text-xs">
            <button
              type="button"
              onClick={() => onChange(new Set(matches.map((o) => o.value)))}
              className="text-[var(--color-primary)] hover:underline"
            >
              Select {query ? 'matching' : 'all'}
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {matches.length === 0 ? (
              <p className="px-3 py-3 text-sm text-gray-400 italic">Nothing matches that.</p>
            ) : (
              matches.map((o) => (
                <label
                  key={o.value}
                  className="flex items-start gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.value)}
                    onChange={() => toggle(o.value)}
                    className="mt-0.5 rounded border-gray-300"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-gray-800">{o.label}</span>
                    {o.hint && <span className="block text-[10px] text-gray-500">{o.hint}</span>}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MultiSelect;
