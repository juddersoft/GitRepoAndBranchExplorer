import { describe, expect, it } from 'vitest';
import type { CommitNode } from '../src/types/git';
import type { GraphSegment } from '../src/webview/ui/graphLayout';
import { computeGraphLayout } from '../src/webview/ui/graphLayout';

function commit(hash: string, parents: string[] = [], isHead = false): CommitNode {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents,
    subject: `commit ${hash}`,
    authorName: 'Test',
    authorEmail: 'test@example.com',
    authorDateIso: '2024-01-01T00:00:00Z',
    authorTimestamp: 1704067200,
    refs: isHead ? [{ kind: 'head', label: 'HEAD' }] : [],
  };
}

const top = (fromLane: number, toLane: number, colorIndex: number): GraphSegment => ({ fromLane, toLane, colorIndex, half: 'top' });
const bottom = (fromLane: number, toLane: number, colorIndex: number): GraphSegment => ({ fromLane, toLane, colorIndex, half: 'bottom' });

describe('computeGraphLayout', () => {
  it('returns no rows for an empty list', () => {
    expect(computeGraphLayout([])).toEqual([]);
  });

  it('keeps a linear chain on lane 0 with continuous rails', () => {
    const rows = computeGraphLayout([commit('c3', ['c2'], true), commit('c2', ['c1']), commit('c1')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.colorIndex)).toEqual([0, 0, 0]);
    expect(rows[0].segments).toEqual([bottom(0, 0, 0)]);
    expect(rows[1].segments).toEqual([top(0, 0, 0), bottom(0, 0, 0)]);
    expect(rows[2].segments).toEqual([top(0, 0, 0)]);
    expect(rows.every((r) => r.maxLanesInWindow === 1)).toBe(true);
    expect(rows.map((r) => r.isHead)).toEqual([true, false, false]);
    expect(rows.some((r) => r.isMerge)).toBe(false);
  });

  it('lays out a fork/merge diamond on two lanes and converges into the common ancestor', () => {
    // M merges F into B; both descend from A.
    const rows = computeGraphLayout([commit('M', ['B', 'F']), commit('F', ['A']), commit('B', ['A']), commit('A')]);
    const [m, f, b, a] = rows;

    expect(m).toMatchObject({ lane: 0, colorIndex: 0, isMerge: true });
    expect(m.segments).toEqual([bottom(0, 0, 0), bottom(0, 1, 1)]);

    expect(f).toMatchObject({ lane: 1, colorIndex: 1, isMerge: false });
    expect(f.segments).toEqual([top(0, 0, 0), bottom(0, 0, 0), top(1, 1, 1), bottom(1, 1, 1)]);

    // B's first parent is already expected on lane 1, so B curves into it and frees lane 0.
    expect(b).toMatchObject({ lane: 0, colorIndex: 0 });
    expect(b.segments).toEqual([top(1, 1, 1), bottom(1, 1, 1), top(0, 0, 0), bottom(0, 1, 0)]);

    expect(a).toMatchObject({ lane: 1, colorIndex: 1 });
    expect(a.segments).toEqual([top(1, 1, 1)]);

    expect(rows.every((r) => r.maxLanesInWindow === 2)).toBe(true);
  });

  it('converges the side branch back into lane 0 when the first-parent line comes first', () => {
    const rows = computeGraphLayout([commit('M', ['B', 'F']), commit('B', ['A']), commit('F', ['A']), commit('A')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    expect(rows[2].segments).toEqual([top(0, 0, 0), bottom(0, 0, 0), top(1, 1, 1), bottom(1, 0, 1)]);
    expect(rows[3].segments).toEqual([top(0, 0, 0)]);
  });

  it('recycles freed lanes for new branch tips', () => {
    // X is an unrelated tip that appears while lane 0 is free and lane 1 still expects A.
    const rows = computeGraphLayout([commit('M', ['B', 'F']), commit('F', ['A']), commit('B', ['A']), commit('X'), commit('A'), commit('Y')]);
    const x = rows[3];
    const y = rows[5];

    expect(x.lane).toBe(0);
    expect(x.colorIndex).toBe(2);
    expect(x.segments).toEqual([top(1, 1, 1), bottom(1, 1, 1)]);
    // After A terminates, every lane is free again and the next tip starts back at lane 0.
    expect(y.lane).toBe(0);
    expect(y.segments).toEqual([]);
  });

  it('allocates a lane per extra parent for an octopus merge', () => {
    const rows = computeGraphLayout([
      commit('O', ['P1', 'P2', 'P3']),
      commit('P1', ['R']),
      commit('P2', ['R']),
      commit('P3', ['R']),
      commit('R'),
    ]);
    const [o, p1, p2, p3, r] = rows;

    expect(o).toMatchObject({ lane: 0, isMerge: true });
    expect(o.segments).toEqual([bottom(0, 0, 0), bottom(0, 1, 1), bottom(0, 2, 2)]);
    expect(p1.segments).toEqual([top(1, 1, 1), bottom(1, 1, 1), top(2, 2, 2), bottom(2, 2, 2), top(0, 0, 0), bottom(0, 0, 0)]);
    expect(p2).toMatchObject({ lane: 1, colorIndex: 1 });
    expect(p2.segments).toEqual([top(0, 0, 0), bottom(0, 0, 0), top(2, 2, 2), bottom(2, 2, 2), top(1, 1, 1), bottom(1, 0, 1)]);
    expect(p3).toMatchObject({ lane: 2, colorIndex: 2 });
    expect(p3.segments).toEqual([top(0, 0, 0), bottom(0, 0, 0), top(2, 2, 2), bottom(2, 0, 2)]);
    expect(r).toMatchObject({ lane: 0, colorIndex: 0 });
    expect(r.segments).toEqual([top(0, 0, 0)]);
    expect(rows.every((row) => row.maxLanesInWindow === 3)).toBe(true);
  });

  it('terminates multiple independent roots without leaving active lanes', () => {
    const rows = computeGraphLayout([commit('R1'), commit('R2'), commit('C', ['R3']), commit('R3')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    expect(rows.map((r) => r.colorIndex)).toEqual([0, 1, 2, 2]);
    expect(rows[0].segments).toEqual([]);
    expect(rows[1].segments).toEqual([]);
    expect(rows[3].segments).toEqual([top(0, 0, 2)]);
    expect(rows.every((r) => r.maxLanesInWindow === 1)).toBe(true);
  });

  it('does not emit dangling segments for parents missing from a filtered or truncated list', () => {
    const rows = computeGraphLayout([commit('C2', ['C1']), commit('C1', ['outside-window']), commit('M', ['C0', 'filtered-out']), commit('C0')]);

    expect(rows[1].segments).toEqual([top(0, 0, 0)]);
    // Only the visible parent of the merge is routed.
    expect(rows[2].segments).toEqual([bottom(0, 0, 1)]);
    expect(rows[2].isMerge).toBe(true);
    expect(rows[3].segments).toEqual([top(0, 0, 1)]);
    expect(rows.flatMap((r) => r.segments).every((s) => s.fromLane === 0 && s.toLane === 0)).toBe(true);
  });

  it('ignores parents that appear before their child and duplicate parent entries', () => {
    const rows = computeGraphLayout([commit('P'), commit('C', ['P', 'P'])]);

    expect(rows[1].segments).toEqual([]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0]);
  });

  it('routes a merge parent into a lane that already expects it', () => {
    // T already expects Z on lane 0 when merge M (lane 1) names Z as its second parent.
    const rows = computeGraphLayout([commit('T', ['Z']), commit('M', ['B', 'Z']), commit('B', ['Z']), commit('Z')]);

    expect(rows[1]).toMatchObject({ lane: 1, colorIndex: 1 });
    expect(rows[1].segments).toEqual([top(0, 0, 0), bottom(0, 0, 0), bottom(1, 1, 1), bottom(1, 0, 0)]);
    expect(rows[2].segments).toEqual([top(0, 0, 0), bottom(0, 0, 0), top(1, 1, 1), bottom(1, 0, 1)]);
    expect(rows[3]).toMatchObject({ lane: 0, segments: [top(0, 0, 0)] });
    expect(rows.every((r) => r.maxLanesInWindow === 2)).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const input = [commit('M', ['B', 'F']), commit('F', ['A']), commit('B', ['A']), commit('A')];
    expect(computeGraphLayout(input)).toEqual(computeGraphLayout(input.map((c) => ({ ...c }))));
  });
});
