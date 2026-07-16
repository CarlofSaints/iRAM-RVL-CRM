'use client';

import { useMemo, useRef, useState } from 'react';

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;
/** Map of column key → how to read the sortable value off a row. */
export type Accessors<T> = Record<string, (row: T) => SortValue>;

/**
 * Client-side table sorting shared across every grid in the app.
 *
 * Mirrors the hand-rolled pattern first used on the Picking Slips page:
 * click a header to sort, click the same header again to flip direction.
 * Blank / missing values always fall to the bottom regardless of direction.
 *
 * `initialCol` + `initialDir` set the default order — pass a date column with
 * `'desc'` for newest-first.
 */
export function useTableSort<T>(
  rows: T[],
  accessors: Accessors<T>,
  initialCol: string,
  initialDir: SortDir = 'asc',
) {
  const [sortCol, setSortCol] = useState(initialCol);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  // Hold the latest accessors in a ref so `sorted` doesn't recompute on every
  // render — accessor maps are usually defined inline in the component body.
  const accessorsRef = useRef(accessors);
  accessorsRef.current = accessors;

  function toggleSort(col: string) {
    if (sortCol === col) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  const sorted = useMemo(() => {
    const acc = accessorsRef.current[sortCol];
    if (!acc) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = acc(a);
      const bv = acc(b);
      const aEmpty = av == null || av === '';
      const bEmpty = bv == null || bv === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // blanks last
      if (bEmpty) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });
  }, [rows, sortCol, sortDir]);

  return { sorted, sortCol, sortDir, toggleSort, setSortCol, setSortDir };
}
