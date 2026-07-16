'use client';

import { ReactNode } from 'react';
import type { SortDir } from '@/lib/useTableSort';

interface SortableThProps {
  /** Column key — must match a key in the grid's accessors map. */
  col: string;
  label: ReactNode;
  sortCol: string;
  sortDir: SortDir;
  onSort: (col: string) => void;
  /** Extra classes for padding/alignment, e.g. "px-3 py-2 text-right". */
  className?: string;
  title?: string;
}

/**
 * A clickable table header cell that sorts the grid and shows a ▲/▼ marker on
 * the active column. Matches the look of the original Picking Slips grid so
 * every sortable grid in the app behaves identically.
 */
export default function SortableTh({
  col,
  label,
  sortCol,
  sortDir,
  onSort,
  className,
  title,
}: SortableThProps) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      title={title}
      className={`cursor-pointer select-none hover:text-gray-900 ${className ?? ''}`}
    >
      {label}
      {active && (
        <span className="ml-1 text-[var(--color-primary)]">{sortDir === 'asc' ? '▲' : '▼'}</span>
      )}
    </th>
  );
}
