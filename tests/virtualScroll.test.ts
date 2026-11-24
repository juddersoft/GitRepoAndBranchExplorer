import { describe, expect, it } from 'vitest';
import {
  computeRevealScrollTop,
  computeVirtualWindow,
  shouldPrefetchMoreCommits,
} from '../src/webview/ui/virtualScroll';

describe('virtual scroll math', () => {
  it('returns an empty window for no rows', () => {
    expect(computeVirtualWindow(0, 26, 100, 200)).toEqual({
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
    });
  });

  it('clamps the window at both data boundaries', () => {
    const top = computeVirtualWindow(10, 26, 0, 52, 2);
    expect(top).toEqual({
      startIndex: 0,
      endIndex: 4,
      topSpacerHeight: 0,
      bottomSpacerHeight: 156,
      totalHeight: 260,
    });
    const bottom = computeVirtualWindow(10, 26, 260, 52, 2);
    expect(bottom.startIndex).toBe(7);
    expect(bottom.endIndex).toBe(10);
    expect(bottom.topSpacerHeight).toBe(182);
    expect(bottom.bottomSpacerHeight).toBe(0);
  });

  it('includes overscan rows around the viewport', () => {
    const window = computeVirtualWindow(100, 26, 1300, 130, 3);
    expect(window.startIndex).toBe(47);
    expect(window.endIndex).toBe(58);
    expect(window.topSpacerHeight).toBe(47 * 26);
    expect(window.bottomSpacerHeight).toBe(42 * 26);
  });

  it('prefetches within the configured row threshold', () => {
    expect(shouldPrefetchMoreCommits(0, 260, 10_000, 26, 100)).toBe(false);
    expect(shouldPrefetchMoreCommits(7200, 260, 10_000, 26, 100)).toBe(true);
    expect(shouldPrefetchMoreCommits(0, 500, 500, 26)).toBe(false);
  });

  it('centers reveal targets without scrolling above zero', () => {
    expect(computeRevealScrollTop(0, 26, 200)).toBe(0);
    expect(computeRevealScrollTop(10, 26, 104)).toBe(221);
  });
});
