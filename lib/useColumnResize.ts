'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Drag-to-resize table columns, shared across grids.
 *
 * Lifted verbatim from the behaviour first built on the Stores grid
 * (app/control-centre/stores/page.tsx) so every resizable grid drags the same
 * way. Pairs with `useTableSort` + `SortableTh` — reuse all three for a new
 * grid rather than re-rolling the state per page.
 *
 * Usage:
 *   const { colWidths, startResize, tableStyle, widthStyle } = useColumnResize(cols.length);
 *   <table style={tableStyle}>
 *     <th style={widthStyle(i)}>
 *       Label
 *       <span onMouseDown={e => startResize(i, e)} className="…cursor-col-resize" />
 *     </th>
 */
export function useColumnResize(columnCount: number, minWidth = 50) {
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const resizing = useRef<{ idx: number; startX: number; startW: number } | null>(null);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizing.current) return;
      const diff = e.clientX - resizing.current.startX;
      setColWidths(prev => ({
        ...prev,
        [resizing.current!.idx]: Math.max(minWidth, resizing.current!.startW + diff),
      }));
    }
    function onMouseUp() {
      if (!resizing.current) return;
      resizing.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth]);

  function startResize(colIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest('th');
    if (!th) return;
    resizing.current = { idx: colIdx, startX: e.clientX, startW: th.getBoundingClientRect().width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  /**
   * Only switch to `table-layout: fixed` once something has actually been
   * dragged — until then the browser's auto layout gives better default widths.
   */
  const resized = Object.keys(colWidths).length > 0;
  const tableStyle: React.CSSProperties | undefined = resized
    ? { tableLayout: 'fixed', minWidth: (columnCount + 1) * 100 }
    : undefined;

  const widthStyle = (idx: number): React.CSSProperties | undefined =>
    colWidths[idx] ? { width: colWidths[idx] } : undefined;

  function resetWidths() {
    setColWidths({});
  }

  return { colWidths, startResize, tableStyle, widthStyle, resetWidths, resized };
}

/** Class list for the drag handle sliver on the right edge of a header cell. */
export const RESIZE_HANDLE_CLASS =
  'absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--color-primary)]/30 z-10';
