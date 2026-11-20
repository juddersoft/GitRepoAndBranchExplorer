import { describe, expect, it } from 'vitest';
import type { BranchInfo, CommitNode, RefBadge, RepoSnapshot } from '../src/types/git';
import type { ExplorerUiState } from '../src/webview/ui/state';
import {
  cacheCommitDetails,
  computeVisibleCommits,
  createInitialState,
  filterBranches,
  filterVisibleBadges,
  reconcileStateWithSnapshot,
  remoteNodeKey,
} from '../src/webview/ui/state';

const sha = (char: string): string => char.repeat(40);

describe('cacheCommitDetails', () => {
  const details = (char: string) => ({ hash: sha(char), body: char, files: [] });

  it('stores entries without mutating the previous cache', () => {
    const empty = new Map();
    const next = cacheCommitDetails(empty, details('a'));
    expect(empty.size).toBe(0);
    expect(next.get(sha('a'))?.body).toBe('a');
  });

  it('evicts the least recently stored entries beyond the limit', () => {
    let cache = cacheCommitDetails(new Map(), details('a'), 2);
    cache = cacheCommitDetails(cache, details('b'), 2);
    cache = cacheCommitDetails(cache, details('a'), 2);
    cache = cacheCommitDetails(cache, details('c'), 2);
    expect([...cache.keys()]).toEqual([sha('a'), sha('c')]);
  });
});

function branch(name: string, tipHash: string, remoteName: string | null = null): BranchInfo {
  const displayName = remoteName ? name.slice(remoteName.length + 1) : name;
  return {
    name,
    displayName,
    fullName: remoteName ? `refs/remotes/${name}` : `refs/heads/${name}`,
    isCurrent: false,
    isRemote: remoteName !== null,
    remoteName,
    tipHash,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}

function commit(hash: string, parents: string[], subject: string, refs: RefBadge[] = [], author = 'Ada Lovelace'): CommitNode {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents,
    subject,
    authorName: author,
    authorEmail: `${author.split(' ')[0].toLowerCase()}@example.com`,
    authorDateIso: '2023-11-14T22:13:20+00:00',
    authorTimestamp: 1700000000,
    refs,
  };
}

/*
 * History (newest first):
 *   M  merge of F2 into B   <- main
 *   F2                      <- feature
 *   B
 *   F1  (side of feature)
 *   A   root
 *   X   unrelated orphan    <- orphan
 */
const A = sha('a');
const B = sha('b');
const F1 = sha('c');
const F2 = sha('d');
const M = sha('e');
const X = sha('f');

const main = branch('main', M);
const feature = branch('feature', F2);
const orphan = branch('orphan', X);
const originMain = branch('origin/main', B, 'origin');

const snapshot: RepoSnapshot = {
  repoName: 'repo',
  repoRoot: '/repo',
  currentBranch: 'main',
  isDetachedHead: false,
  localBranches: [main, feature, orphan],
  remoteGroups: [{ remoteName: 'origin', branches: [originMain] }],
  tags: [],
  commits: [
    commit(M, [B, F2], "Merge branch 'feature'", [{ kind: 'head', label: 'HEAD' }, { kind: 'localBranch', label: 'main' }]),
    commit(F2, [F1], 'Feature: part two', [{ kind: 'localBranch', label: 'feature' }], 'Grace Hopper'),
    commit(B, [A], 'Fix | pipes: and "quotes"', [{ kind: 'remoteBranch', label: 'origin/main' }]),
    commit(F1, [A], 'Feature: part one', [], 'Grace Hopper'),
    commit(A, [], 'Initial commit', [{ kind: 'tag', label: 'v1.0.0' }]),
    commit(X, [], 'Orphan root', [{ kind: 'localBranch', label: 'orphan' }]),
  ],
};

function stateWith(patch: Partial<ExplorerUiState>): ExplorerUiState {
  return { ...createInitialState(), snapshot, ...patch };
}

const hashes = (commits: CommitNode[]): string[] => commits.map((c) => c.hash);

describe('filterBranches', () => {
  const branches = [main, feature, branch('Feature/UPPER', sha('1')), originMain];

  it('returns every branch for an empty or whitespace query', () => {
    expect(filterBranches(branches, '')).toEqual(branches);
    expect(filterBranches(branches, '   ')).toEqual(branches);
  });

  it('matches name and displayName case-insensitively', () => {
    expect(filterBranches(branches, 'FEATURE').map((b) => b.name)).toEqual(['feature', 'Feature/UPPER']);
    expect(filterBranches(branches, 'origin/').map((b) => b.name)).toEqual(['origin/main']);
    expect(filterBranches(branches, 'main').map((b) => b.name)).toEqual(['main', 'origin/main']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterBranches(branches, 'nope')).toEqual([]);
  });
});

describe('computeVisibleCommits', () => {
  it('shows every commit when nothing is pinned or filtered', () => {
    expect(hashes(computeVisibleCommits(snapshot, stateWith({})))).toEqual([M, F2, B, F1, A, X]);
  });

  it('walks the ancestors of a single pinned branch', () => {
    const state = stateWith({ pinnedBranchFullNames: new Set([feature.fullName]) });
    expect(hashes(computeVisibleCommits(snapshot, state))).toEqual([F2, F1, A]);
  });

  it('follows both parents of a merge commit', () => {
    const state = stateWith({ pinnedBranchFullNames: new Set([main.fullName]) });
    expect(hashes(computeVisibleCommits(snapshot, state))).toEqual([M, F2, B, F1, A]);
  });

  it('unions the lineage of multiple pinned branches, including remotes', () => {
    const state = stateWith({ pinnedBranchFullNames: new Set([originMain.fullName, orphan.fullName]) });
    expect(hashes(computeVisibleCommits(snapshot, state))).toEqual([B, A, X]);
  });

  it('ignores pins that do not match any branch in the snapshot', () => {
    const state = stateWith({ pinnedBranchFullNames: new Set(['refs/heads/deleted']) });
    expect(computeVisibleCommits(snapshot, state)).toEqual([]);
  });

  it.each([
    ['message', 'PART TWO', [F2]],
    ['message with special characters', '| pipes: and "quotes"', [B]],
    ['author name', 'grace', [F2, F1]],
    ['author email', 'ada@example', [M, B, A, X]],
    ['short hash prefix', B.slice(0, 8), [B]],
    ['full hash', A, [A]],
    ['ref label', 'v1.0', [A]],
    ['remote ref label', 'origin/main', [B]],
  ])('filters history by %s', (_label, query, expected) => {
    expect(hashes(computeVisibleCommits(snapshot, stateWith({ historyFilterText: query })))).toEqual(expected);
  });

  it('combines pinning with the history filter', () => {
    const state = stateWith({ pinnedBranchFullNames: new Set([feature.fullName]), historyFilterText: 'feature:' });
    expect(hashes(computeVisibleCommits(snapshot, state))).toEqual([F2, F1]);
  });
});

describe('filterVisibleBadges', () => {
  const refs: RefBadge[] = [
    { kind: 'head', label: 'HEAD' },
    { kind: 'localBranch', label: 'main' },
    { kind: 'remoteBranch', label: 'origin/main' },
    { kind: 'tag', label: 'v1.0.0' },
  ];
  const kinds = (state: Partial<ExplorerUiState>): string[] => filterVisibleBadges(refs, stateWith(state)).map((r) => r.kind);

  it('shows everything by default', () => {
    expect(kinds({})).toEqual(['head', 'localBranch', 'remoteBranch', 'tag']);
  });

  it('hides HEAD together with local branches', () => {
    expect(kinds({ showLocalBranchBadges: false })).toEqual(['remoteBranch', 'tag']);
  });

  it('toggles remote and tag badges independently', () => {
    expect(kinds({ showRemoteBranchBadges: false })).toEqual(['head', 'localBranch', 'tag']);
    expect(kinds({ showTagBadges: false })).toEqual(['head', 'localBranch', 'remoteBranch']);
    expect(kinds({ showLocalBranchBadges: false, showRemoteBranchBadges: false, showTagBadges: false })).toEqual([]);
  });
});

describe('reconcileStateWithSnapshot', () => {
  it('drops stale pins and selection, and expands only newly seen remotes', () => {
    const previous = stateWith({
      snapshot: null,
      isLoading: true,
      errorMessage: 'old',
      pinnedBranchFullNames: new Set([main.fullName, 'refs/heads/deleted']),
      selectedCommitHash: sha('9'),
      expandedNodes: new Set(['branches']),
    });
    const withUpstream: RepoSnapshot = {
      ...snapshot,
      remoteGroups: [...snapshot.remoteGroups, { remoteName: 'upstream', branches: [branch('upstream/main', A, 'upstream')] }],
    };

    const next = reconcileStateWithSnapshot(previous, withUpstream, new Set(['origin']));

    expect(next.snapshot).toBe(withUpstream);
    expect(next.isLoading).toBe(false);
    expect(next.errorMessage).toBeNull();
    expect([...next.pinnedBranchFullNames]).toEqual([main.fullName]);
    expect(next.selectedCommitHash).toBeNull();
    expect(next.expandedNodes.has(remoteNodeKey('upstream'))).toBe(true);
    expect(next.expandedNodes.has(remoteNodeKey('origin'))).toBe(false);
  });

  it('keeps a selection that still exists', () => {
    const next = reconcileStateWithSnapshot(stateWith({ selectedCommitHash: B }), snapshot, new Set());
    expect(next.selectedCommitHash).toBe(B);
  });
});
