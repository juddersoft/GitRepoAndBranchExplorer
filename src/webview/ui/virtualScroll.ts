export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
}

export const DEFAULT_VIRTUAL_OVERSCAN = 15;

export function computeVirtualWindow(
  totalRows: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = DEFAULT_VIRTUAL_OVERSCAN,
): VirtualWindow {
  const rowCount = Math.max(0, Math.floor(Number.isFinite(totalRows) ? totalRows : 0));
  const safeRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewportHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const safeOverscan = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : DEFAULT_VIRTUAL_OVERSCAN));
  const totalHeight = rowCount * safeRowHeight;

  if (rowCount === 0) {
    return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight };
  }

  const firstVisible = Math.min(rowCount - 1, Math.floor(safeScrollTop / safeRowHeight));
  const visibleEnd = Math.min(rowCount, Math.ceil((safeScrollTop + safeViewportHeight) / safeRowHeight));
  const startIndex = Math.max(0, firstVisible - safeOverscan);
  const endIndex = Math.min(rowCount, Math.max(firstVisible + 1, visibleEnd + safeOverscan));
  return {
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * safeRowHeight,
    bottomSpacerHeight: Math.max(0, totalHeight - endIndex * safeRowHeight),
    totalHeight,
  };
}

export function shouldPrefetchMoreCommits(
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  rowHeight: number,
  thresholdRows = 100,
): boolean {
  if (![scrollTop, viewportHeight, scrollHeight, rowHeight, thresholdRows].every(Number.isFinite)) {
    return false;
  }
  if (scrollHeight <= viewportHeight || rowHeight <= 0 || thresholdRows < 0) {
    return false;
  }
  return scrollTop + viewportHeight + rowHeight * thresholdRows >= scrollHeight;
}

export function computeRevealScrollTop(rowIndex: number, rowHeight: number, viewportHeight: number): number {
  const safeRowIndex = Math.max(0, Math.floor(Number.isFinite(rowIndex) ? rowIndex : 0));
  const safeRowHeight = Math.max(1, Number.isFinite(rowHeight) ? rowHeight : 1);
  const safeViewportHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  return Math.max(0, safeRowIndex * safeRowHeight + safeRowHeight / 2 - safeViewportHeight / 2);
}
