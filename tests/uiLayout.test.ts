import { describe, expect, it } from 'vitest';
import {
  clampColumnWidth,
  computeTableMinWidth,
  DEFAULT_COLUMN_WIDTHS,
  resolveColumnWidths,
  sanitizeStoredColumnWidths,
} from '../src/webview/ui/columnResize';
import { computeCheckedOutPillLayout, MIN_READABLE_PILL_SCALE } from '../src/webview/ui/pillLayout';
import { getTrackingOrderSequence } from '../src/webview/ui/BranchTree';

describe('tracking indicator order', () => {
  it('uses incoming then outgoing for VS Code and outgoing then incoming for Visual Studio', () => {
    expect(getTrackingOrderSequence('vscode')).toEqual(['down', 'up']);
    expect(getTrackingOrderSequence('visualStudio')).toEqual(['up', 'down']);
  });
});

describe('computeCheckedOutPillLayout', () => {
  const base = { prefixWidth: 40, branchLabelNaturalWidth: 100, trackingWidth: 50, pillBaseWidth: 60 };
  // Space left for the pill is rowAvailableWidth - 190.
  const layout = (rowAvailableWidth: number) => computeCheckedOutPillLayout({ ...base, rowAvailableWidth });

  it('keeps full size when there is ample room, never scaling above 1', () => {
    expect(layout(250)).toEqual({ visible: true, scale: 1 });
    expect(layout(2000)).toEqual({ visible: true, scale: 1 });
  });

  it('scales proportionally while the branch name keeps its full reserved width', () => {
    const { visible, scale } = layout(190 + 54);
    expect(visible).toBe(true);
    expect(scale).toBeCloseTo(0.9);
    expect(scale).toBeGreaterThanOrEqual(MIN_READABLE_PILL_SCALE);
    expect(scale).toBeLessThan(1);
    // Reserved width plus the scaled pill still fits the row.
    expect(base.prefixWidth + base.branchLabelNaturalWidth + base.trackingWidth + scale * base.pillBaseWidth).toBeLessThanOrEqual(190 + 54);
  });

  it('is still visible exactly at the readability threshold', () => {
    const result = layout(190 + 60 * MIN_READABLE_PILL_SCALE);
    expect(result.visible).toBe(true);
    expect(result.scale).toBeCloseTo(MIN_READABLE_PILL_SCALE);
  });

  it('hides the pill below the threshold or when the name already needs all the room', () => {
    expect(layout(190 + 60 * MIN_READABLE_PILL_SCALE - 1)).toEqual({ visible: false, scale: 0 });
    expect(layout(190)).toEqual({ visible: false, scale: 0 });
    expect(layout(100)).toEqual({ visible: false, scale: 0 });
  });

  it('honours a custom readability threshold and rejects a degenerate pill width', () => {
    expect(computeCheckedOutPillLayout({ ...base, rowAvailableWidth: 190 + 30, minReadableScale: 0.4 })).toEqual({ visible: true, scale: 0.5 });
    expect(computeCheckedOutPillLayout({ ...base, rowAvailableWidth: 500, pillBaseWidth: 0 })).toEqual({ visible: false, scale: 0 });
  });

  it('returns a finite hidden result for zero, negative, NaN, or infinite widths', () => {
    for (const rowAvailableWidth of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      const result = computeCheckedOutPillLayout({ ...base, rowAvailableWidth });
      expect(result).toEqual({ visible: false, scale: 0 });
      expect(Number.isNaN(result.scale)).toBe(false);
      expect(Number.isFinite(result.scale)).toBe(true);
    }
    for (const pillBaseWidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = computeCheckedOutPillLayout({ ...base, pillBaseWidth });
      expect(result).toEqual({ visible: false, scale: 0 });
      expect(Number.isNaN(result.scale)).toBe(false);
      expect(Number.isFinite(result.scale)).toBe(true);
    }
  });

  it('uses exact readable boundaries and caps a very wide sidebar at 1', () => {
    const atBoundary = computeCheckedOutPillLayout({
      ...base,
      rowAvailableWidth: 190 + 60 * MIN_READABLE_PILL_SCALE,
    });
    const justAbove = computeCheckedOutPillLayout({
      ...base,
      rowAvailableWidth: 190 + 60 * MIN_READABLE_PILL_SCALE + 0.001,
    });
    const justBelow = computeCheckedOutPillLayout({
      ...base,
      rowAvailableWidth: 190 + 60 * MIN_READABLE_PILL_SCALE - 0.001,
    });
    expect(atBoundary.visible).toBe(true);
    expect(atBoundary.scale).toBeCloseTo(MIN_READABLE_PILL_SCALE);
    expect(justAbove.visible).toBe(true);
    expect(justAbove.scale).toBeGreaterThan(MIN_READABLE_PILL_SCALE);
    expect(justBelow).toEqual({ visible: false, scale: 0 });
    expect(layout(1_000_000)).toEqual({ visible: true, scale: 1 });
  });

  it('uses a 52% readability floor and keeps intermediate scales visible', () => {
    expect(MIN_READABLE_PILL_SCALE).toBe(0.52);
    for (const scale of [0.7, 0.6, 0.53]) {
      const result = layout(190 + 60 * scale);
      expect(result.visible).toBe(true);
      expect(result.scale).toBeCloseTo(scale);
    }
    expect(layout(190 + 60 * 0.51)).toEqual({ visible: false, scale: 0 });
  });

  it('hides whenever fixed content consumes all available row width', () => {
    expect(computeCheckedOutPillLayout({ ...base, rowAvailableWidth: 190 })).toEqual({ visible: false, scale: 0 });
    expect(computeCheckedOutPillLayout({ ...base, rowAvailableWidth: 189 })).toEqual({ visible: false, scale: 0 });
  });
});

describe('column resize math', () => {
  it('enforces each column minimum, including a 36px author column', () => {
    expect(clampColumnWidth('refs', 10, 56)).toBe(72);
    expect(clampColumnWidth('message', 10, 56)).toBe(100);
    expect(clampColumnWidth('author', 10, 56)).toBe(36);
    expect(clampColumnWidth('author', 36, 56)).toBe(36);
    expect(clampColumnWidth('date', 10, 56)).toBe(72);
    expect(clampColumnWidth('id', 10, 56)).toBe(56);
    expect(clampColumnWidth('date', 200, 56)).toBe(200);
  });

  it('never lets the graph column shrink below the width its lanes need', () => {
    expect(clampColumnWidth('graph', 20, 56)).toBe(56);
    expect(clampColumnWidth('graph', 100, 200)).toBe(200);
    expect(clampColumnWidth('graph', 300, 200)).toBe(300);
  });

  it('falls back to the minimum for non-finite widths and caps runaway ones', () => {
    expect(clampColumnWidth('date', Number.NaN, 56)).toBe(72);
    expect(clampColumnWidth('date', Number.POSITIVE_INFINITY, 56)).toBe(72);
    expect(clampColumnWidth('date', Number.NEGATIVE_INFINITY, 56)).toBe(72);
    expect(clampColumnWidth('author', Number.NaN, 56)).toBe(36);
    expect(clampColumnWidth('author', Number.POSITIVE_INFINITY, 56)).toBe(36);
    expect(clampColumnWidth('author', -100, 56)).toBe(36);
    expect(clampColumnWidth('date', 1e9, 56)).toBeLessThan(1e9);
  });

  it('sums the clamped widths for the table minimum', () => {
    expect(computeTableMinWidth(DEFAULT_COLUMN_WIDTHS, 56)).toBe(155 + 56 + 260 + 150 + 140 + 84);
    expect(computeTableMinWidth({ refs: 10, graph: 10, message: 10, author: 10, date: 10, id: 10 }, 120)).toBe(72 + 120 + 100 + 36 + 72 + 56);
  });

  it('resolves stored overrides over defaults and keeps the graph at or above its lane width', () => {
    expect(resolveColumnWidths({}, 56)).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(resolveColumnWidths({ author: 40, graph: 60 }, 56)).toMatchObject({ author: 40, graph: 60, date: 140 });
    expect(resolveColumnWidths({ graph: 60 }, 200).graph).toBe(200);
    expect(resolveColumnWidths({}, 200).graph).toBe(200);
  });

  it('keeps only valid persisted widths for known columns', () => {
    const polluted = JSON.parse('{"author":50,"date":"wide","id":null,"bogus":10,"__proto__":{"refs":99}}') as unknown;
    expect(sanitizeStoredColumnWidths(polluted)).toEqual({ author: 50 });
    expect(sanitizeStoredColumnWidths({ refs: 1 })).toEqual({ refs: 72 });
    expect(sanitizeStoredColumnWidths(null)).toEqual({});
    expect(sanitizeStoredColumnWidths([1, 2])).toEqual({});
  });
});

