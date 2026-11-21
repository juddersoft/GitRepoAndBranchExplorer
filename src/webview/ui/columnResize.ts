/** Pure column-width rules for the commit history table (kept free of DOM so they can be unit-tested). */

export const COLUMN_KEYS = ['refs', 'graph', 'message', 'author', 'date', 'id'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export type ColumnWidths = Readonly<Record<ColumnKey, number>>;
/** Only the columns the user has resized; every other column keeps its default. */
export type StoredColumnWidths = Readonly<Partial<Record<ColumnKey, number>>>;

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  refs: 155,
  graph: 56,
  message: 260,
  author: 150,
  date: 140,
  id: 84,
};

/** The graph minimum is dynamic (it must fit every lane), so its entry here is only the floor. */
export const MIN_COLUMN_WIDTHS: ColumnWidths = {
  refs: 72,
  graph: 56,
  message: 100,
  // Narrow enough to leave just the avatar, like Visual Studio's compact author column.
  author: 36,
  date: 72,
  id: 56,
};

/** Upper bound that keeps a corrupt persisted value or a runaway drag from producing an absurd table. */
export const MAX_COLUMN_WIDTH = 4000;

export function minColumnWidth(key: ColumnKey, activeGraphWidth: number): number {
  if (key === 'graph') {
    const safeActiveGraphWidth = Number.isFinite(activeGraphWidth) ? Math.max(0, activeGraphWidth) : 0;
    return Math.max(MIN_COLUMN_WIDTHS.graph, safeActiveGraphWidth);
  }
  return MIN_COLUMN_WIDTHS[key];
}

export function defaultColumnWidth(key: ColumnKey, activeGraphWidth: number): number {
  return key === 'graph' ? Math.max(DEFAULT_COLUMN_WIDTHS.graph, activeGraphWidth) : DEFAULT_COLUMN_WIDTHS[key];
}

export function clampColumnWidth(key: ColumnKey, proposedWidth: number, minGraphWidth: number): number {
  const min = minColumnWidth(key, minGraphWidth);
  if (!Number.isFinite(proposedWidth)) {
    return min;
  }
  return Math.min(Math.max(proposedWidth, min), Math.max(MAX_COLUMN_WIDTH, min));
}

/** Sum of the (clamped) column widths: the narrowest the table may get before it scrolls horizontally. */
export function computeTableMinWidth(widths: ColumnWidths, minGraphWidth: number): number {
  return COLUMN_KEYS.reduce((sum, key) => sum + clampColumnWidth(key, widths[key], minGraphWidth), 0);
}

/** Effective width of every column: the stored override (if any) or the default, clamped to its minimum. */
export function resolveColumnWidths(stored: StoredColumnWidths, activeGraphWidth: number): ColumnWidths {
  const resolved: Record<ColumnKey, number> = { ...DEFAULT_COLUMN_WIDTHS };
  for (const key of COLUMN_KEYS) {
    resolved[key] = clampColumnWidth(key, stored[key] ?? defaultColumnWidth(key, activeGraphWidth), activeGraphWidth);
  }
  return resolved;
}

/** Reads untrusted persisted webview state, keeping only finite widths for known columns. */
export function sanitizeStoredColumnWidths(raw: unknown): StoredColumnWidths {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const result: Partial<Record<ColumnKey, number>> = {};
  for (const key of COLUMN_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = clampColumnWidth(key, value, MIN_COLUMN_WIDTHS.graph);
    }
  }
  return result;
}
