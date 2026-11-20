import type { CommitNode } from '../../types/git';

export interface GraphSegment {
  fromLane: number;
  toLane: number;
  colorIndex: number;
  /** `'top'`: (fromLane, 0) -> (toLane, mid). `'bottom'`: (fromLane, mid) -> (toLane, height). */
  half: 'top' | 'bottom';
}

export interface GraphRowLayout {
  hash: string;
  lane: number;
  colorIndex: number;
  isMerge: boolean;
  isHead: boolean;
  segments: GraphSegment[];
  /** Widest lane count across all rows, so every row's Graph cell has the same width. */
  maxLanesInWindow: number;
}

function allocateLane(activeLanes: Array<string | null>): number {
  const free = activeLanes.indexOf(null);
  if (free !== -1) {
    return free;
  }
  activeLanes.push(null);
  return activeLanes.length - 1;
}

function findLane(activeLanes: ReadonlyArray<string | null>, hash: string, exclude: number): number {
  for (let i = 0; i < activeLanes.length; i++) {
    if (i !== exclude && activeLanes[i] === hash) {
      return i;
    }
  }
  return -1;
}

/**
 * Assigns deterministic lanes and rail segments to an ordered (newest-first, topological) list of commits.
 * Parents that are not in the list, or that appear before their child, are treated as out of view so lanes
 * end at the node instead of dangling.
 */
export function computeGraphLayout(commits: readonly CommitNode[]): GraphRowLayout[] {
  const positionByHash = new Map<string, number>();
  commits.forEach((commit, index) => {
    if (!positionByHash.has(commit.hash)) {
      positionByHash.set(commit.hash, index);
    }
  });

  const activeLanes: Array<string | null> = [];
  const laneColors: number[] = [];
  let nextColorIndex = 0;
  let maxLanes = 0;
  const rows: GraphRowLayout[] = [];

  commits.forEach((commit, index) => {
    const segments: GraphSegment[] = [];
    const expecting: number[] = [];
    activeLanes.forEach((expected, lane) => {
      if (expected === commit.hash) {
        expecting.push(lane);
      }
    });

    let commitLane: number;
    let colorIndex: number;
    const wasActive = expecting.length > 0;
    if (!wasActive) {
      commitLane = allocateLane(activeLanes);
      colorIndex = nextColorIndex++;
      laneColors[commitLane] = colorIndex;
    } else {
      commitLane = expecting[0];
      colorIndex = laneColors[commitLane];
      for (const otherLane of expecting.slice(1)) {
        segments.push({ fromLane: otherLane, toLane: commitLane, colorIndex: laneColors[otherLane], half: 'top' });
        activeLanes[otherLane] = null;
      }
    }

    activeLanes.forEach((expected, lane) => {
      if (lane !== commitLane && expected !== null) {
        segments.push({ fromLane: lane, toLane: lane, colorIndex: laneColors[lane], half: 'top' });
        segments.push({ fromLane: lane, toLane: lane, colorIndex: laneColors[lane], half: 'bottom' });
      }
    });

    if (wasActive) {
      segments.push({ fromLane: commitLane, toLane: commitLane, colorIndex, half: 'top' });
    }

    const parents = [...new Set(commit.parents)].filter((parent) => (positionByHash.get(parent) ?? -1) > index);
    if (parents.length === 0) {
      activeLanes[commitLane] = null;
    } else {
      const existingFirst = findLane(activeLanes, parents[0], commitLane);
      if (existingFirst !== -1) {
        segments.push({ fromLane: commitLane, toLane: existingFirst, colorIndex, half: 'bottom' });
        activeLanes[commitLane] = null;
      } else {
        activeLanes[commitLane] = parents[0];
        segments.push({ fromLane: commitLane, toLane: commitLane, colorIndex, half: 'bottom' });
      }

      for (const parent of parents.slice(1)) {
        const existingLane = findLane(activeLanes, parent, -1);
        if (existingLane !== -1) {
          segments.push({ fromLane: commitLane, toLane: existingLane, colorIndex: laneColors[existingLane], half: 'bottom' });
        } else {
          const newLane = allocateLane(activeLanes);
          const branchColor = nextColorIndex++;
          laneColors[newLane] = branchColor;
          activeLanes[newLane] = parent;
          segments.push({ fromLane: commitLane, toLane: newLane, colorIndex: branchColor, half: 'bottom' });
        }
      }
    }

    let widest = commitLane;
    for (const segment of segments) {
      widest = Math.max(widest, segment.fromLane, segment.toLane);
    }
    maxLanes = Math.max(maxLanes, widest + 1);

    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
    laneColors.length = activeLanes.length;

    rows.push({
      hash: commit.hash,
      lane: commitLane,
      colorIndex,
      isMerge: commit.parents.length > 1,
      isHead: commit.refs.some((ref) => ref.kind === 'head'),
      segments,
      maxLanesInWindow: 0,
    });
  });

  for (const row of rows) {
    row.maxLanesInWindow = maxLanes;
  }
  return rows;
}
