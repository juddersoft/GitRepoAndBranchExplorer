import { describe, expect, it } from 'vitest';
import type { BranchInfo, CommitNode, FileHistoryCommit, RefBadge, RepoSnapshot } from '../src/types/git';
import type { ExplorerUiState } from '../src/webview/ui/state';
import {
  cacheCommitDetails,
  computeVisibleCommits,
  createInitialState,
  describeCommitCount,
  describeEmptyHistory,
  describeHistoryFocus,
  describeRefFilterStatus,
  filterBranches,
  filterTags,
  filterVisibleBadges,
  findRefTarget,
  getFocusedRefs,
  getHeadHash,
  isAncestorOfHead,
  isSameSelection,
  listRefTargets,
  normalizeRepoKey,
  parseHistoryFilterQuery,
  normalizeSelection,
  reconcileStateWithSnapshot,
  repoNodeKey,
  remoteNodeKey,
  selectionFromState,
  selectionPatch,
  selectRefPatch,
  summarizeRefToggles,
  toggleNodeExpansion,
  toggleComparisonSelection,
  orderComparisonPair,
  trackingSummary,
} from '../src/webview/ui/state';

const sha = (char: string): string => char.repeat(40);

describe('file history comparison selection', () => {
  it('adds, removes and slides a two-revision selection', () => {
    const a = sha('a');
    const b = sha('b');
    const c = sha('c');
    expect(toggleComparisonSelection([], a)).toEqual([a]);
    expect(toggleComparisonSelection([a], b)).toEqual([a, b]);
    expect(toggleComparisonSelection([a, b], b)).toEqual([a]);
    expect(toggleComparisonSelection([a, b], c)).toEqual([b, c]);
  });

  const historyCommit = (char: string, timestamp: number): FileHistoryCommit => ({
    hash: sha(char),
    shortHash: sha(char).slice(0, 8),
    parents: [],
    subject: char,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDateIso: '2026-11-10T12:00:00Z',
    authorTimestamp: timestamp,
    refs: [],
    filePathAtCommit: 'src/file.ts',
  });

  it('returns null for fewer than two valid distinct selections', () => {
    const commits = [historyCommit('a', 100)];
    expect(orderComparisonPair(commits, [])).toBeNull();
    expect(orderComparisonPair(commits, [commits[0].hash])).toBeNull();
    expect(orderComparisonPair(commits, [commits[0].hash, commits[0].hash])).toBeNull();
  });

  it('orders older timestamps first regardless of selection order', () => {
    const older = historyCommit('a', 100);
    const newer = historyCommit('b', 200);
    expect(orderComparisonPair([older, newer], [newer.hash, older.hash]))
      .toEqual({ older, newer });
  });

  it('uses higher array index as tie-breaker for equal timestamps', () => {
    const first = historyCommit('a', 100);
    const second = historyCommit('b', 100);
    expect(orderComparisonPair([first, second], [first.hash, second.hash]))
      .toEqual({ older: second, newer: first });
  });

  it('clears file history and comparison selection when a snapshot changes repository', () => {
    const initial = createInitialState();
    const first: RepoSnapshot = { ...snapshot, repoRoot: '/repo/a' };
    const second: RepoSnapshot = { ...snapshot, repoRoot: '/repo/b' };
    const withHistory: ExplorerUiState = {
      ...initial,
      snapshot: first,
      fileHistory: {
        kind: 'file',
        repoRoot: '/repo/a',
        filePath: 'src/file.ts',
        commits: [],
        hasMore: false,
      },
      selectedComparisonHashes: [sha('a'), sha('b')],
    };
    expect(reconcileStateWithSnapshot(withHistory, second, new Set())).toMatchObject({
      fileHistory: null,
      selectedComparisonHashes: [],
    });
  });
});

describe('trackingSummary', () => {
  const local = (patch: Partial<BranchInfo> = {}): BranchInfo => ({ ...branch('main', sha('a')), upstream: 'origin/main', ...patch });

  it('shows explicit zero counts when a tracked branch is up to date', () => {
    expect(trackingSummary(local())).toMatchObject({
      kind: 'synced',
      up: '\u21910',
      down: '\u21930',
      title: 'Up to date with origin/main: nothing to push or pull.',
      label: 'up to date with origin/main',
    });
  });

  it('shows the commits to push (up) and to pull (down)', () => {
    expect(trackingSummary(local({ ahead: 2, behind: 5 }))).toMatchObject({
      kind: 'diverged',
      up: '\u21912',
      down: '\u21935',
      title: '2 commits to push, 5 commits to pull (origin/main).',
      label: '2 commits to push, 5 commits to pull',
    });
    expect(trackingSummary(local({ ahead: 1 }))).toMatchObject({ up: '\u21911', down: '\u21930', label: '1 commit to push, 0 commits to pull' });
    expect(trackingSummary(local({ behind: 1 }))).toMatchObject({ up: '\u21910', down: '\u21931' });
  });

  it('distinguishes a branch with no upstream from an up-to-date one', () => {
    const none = trackingSummary(local({ upstream: null }));
    expect(none).toMatchObject({ kind: 'noUpstream', up: '\u2191\u2013', down: '\u2193\u2013' });
    expect(none?.title).toMatch(/no upstream/i);
    expect(trackingSummary(local({ upstream: '' }))?.kind).toBe('noUpstream');
  });

  it('reports a deleted upstream instead of claiming the branch is up to date', () => {
    const gone = trackingSummary(local({ upstreamGone: true }));
    expect(gone).toMatchObject({ kind: 'gone', up: '\u2191\u2013', down: '\u2193\u2013' });
    expect(gone?.title).toBe('Upstream origin/main no longer exists on the remote.');
  });

  it('has no indicator for remote branches', () => {
    expect(trackingSummary(branch('origin/main', sha('a'), 'origin'))).toBeNull();
  });
});

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
    upstreamGone: false,
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
  worktrees: [],
  stashes: [],
  tags: [],
  commits: [
    commit(M, [B, F2], "Merge branch 'feature'", [{ kind: 'head', label: 'HEAD' }, { kind: 'localBranch', label: 'main' }]),
    commit(F2, [F1], 'Feature: part two', [{ kind: 'localBranch', label: 'feature' }], 'Grace Hopper'),
    commit(B, [A], 'Fix | pipes: and "quotes"', [{ kind: 'remoteBranch', label: 'origin/main' }]),
    commit(F1, [A], 'Feature: part one', [], 'Grace Hopper'),
    commit(A, [], 'Initial commit', [{ kind: 'tag', label: 'v1.0.0' }]),
    commit(X, [], 'Orphan root', [{ kind: 'localBranch', label: 'orphan' }]),
  ],
  hasMoreCommits: false,
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
  it.each([
    ['plain text', 'fix part', { textTerms: ['fix', 'part'], authorTerms: [], hashTerms: [], fileTerms: [] }],
    ['author', 'author:alice', { textTerms: [], authorTerms: ['alice'], hashTerms: [], fileTerms: [] }],
    ['quoted author', 'author:"Peter Judd"', { textTerms: [], authorTerms: ['Peter Judd'], hashTerms: [], fileTerms: [] }],
    ['hash', 'hash:abc123', { textTerms: [], authorTerms: [], hashTerms: ['abc123'], fileTerms: [] }],
    ['file', 'file:src/foo.ts', { textTerms: [], authorTerms: [], hashTerms: [], fileTerms: ['src/foo.ts'] }],
    ['quoted file', 'file:"src/my file.ts"', { textTerms: [], authorTerms: [], hashTerms: [], fileTerms: ['src/my file.ts'] }],
    ['mixed tokens', 'fix author:alice hash:abc file:src/foo.ts', {
      textTerms: ['fix'],
      authorTerms: ['alice'],
      hashTerms: ['abc'],
      fileTerms: ['src/foo.ts'],
    }],
    ['empty prefixes', 'author: hash: file: author:alice', {
      textTerms: [],
      authorTerms: ['alice'],
      hashTerms: [],
      fileTerms: [],
    }],
  ])('parses %s filters', (_label, query, expected) => {
    expect(parseHistoryFilterQuery(query)).toEqual(expected);
  });

  it('parses commit-level author, hash and file filters alongside quoted text terms', () => {
    expect(parseHistoryFilterQuery('fix author:"Grace Hopper" hash:abc file:src/index.ts "part two"')).toEqual({
      textTerms: ['fix', 'part two'],
      authorTerms: ['Grace Hopper'],
      hashTerms: ['abc'],
      fileTerms: ['src/index.ts'],
    });
  });

  it('applies qualifier filters and asynchronous file matches as an AND', () => {
    const state = stateWith({
      historyFilterText: 'author:grace hash:ddd file:src/index.ts',
      historyFileMatchingHashes: new Set([F2]),
    });
    expect(hashes(computeVisibleCommits(snapshot, state))).toEqual([F2]);
    expect(computeVisibleCommits(snapshot, { ...state, historyFileMatchingHashes: new Set() })).toEqual([]);
  });

  it('shows every commit when nothing is pinned or filtered', () => {
    expect(hashes(computeVisibleCommits(snapshot, stateWith({})))).toEqual([M, F2, B, F1, A, X]);
  });

  it('filters accurately by author, hash and author combined with plain text', () => {
    expect(hashes(computeVisibleCommits(snapshot, stateWith({ historyFilterText: 'author:grace' })))).toEqual([F2, F1]);
    expect(hashes(computeVisibleCommits(snapshot, stateWith({ historyFilterText: `hash:${B.slice(0, 8)}` })))).toEqual([B]);
    expect(hashes(computeVisibleCommits(snapshot, stateWith({
      historyFilterText: 'author:grace part two',
    })))).toEqual([F2]);
  });

  it('uses file matches only for the query that produced them', () => {
    const matched = stateWith({
      historyFilterText: 'file:src/foo.ts',
      historyFileMatchingHashes: new Set([F2, A]),
    });
    expect(hashes(computeVisibleCommits(snapshot, matched))).toEqual([F2, A]);

    const mismatched = {
      ...matched,
      historyFileMatchingHashes: new Set<string>(),
    };
    expect(computeVisibleCommits(snapshot, mismatched)).toEqual([]);
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
  it('normalizes mixed Windows roots while expanding and toggling the active repository', () => {
    const workspaceRoot = 'F:\\Syncthing\\Projects\\Repo\\';
    const snapshotRoot = 'f:/Syncthing/Projects/Repo';
    const windowsSnapshot = { ...snapshot, repoRoot: snapshotRoot };
    const initial = stateWith({
      snapshot: null,
      workspaceRepos: [{
        repoRoot: workspaceRoot,
        repoName: 'Repo',
        commonDir: `${workspaceRoot}.git`,
      }],
      activeRepoRoot: workspaceRoot,
    });

    const expanded = reconcileStateWithSnapshot(initial, windowsSnapshot, new Set());
    const key = repoNodeKey(workspaceRoot);

    expect(normalizeRepoKey(workspaceRoot)).toBe(normalizeRepoKey(snapshotRoot));
    expect(key).toBe('repo:f:/Syncthing/Projects/Repo');
    expect(expanded.expandedNodes.has(key)).toBe(true);

    const collapsed = toggleNodeExpansion(expanded.expandedNodes, expanded.collapsedRepoNodes, key);
    expect(collapsed.expandedNodes.has(key)).toBe(false);
    expect(collapsed.collapsedRepoNodes.has(key)).toBe(true);

    const reopened = toggleNodeExpansion(collapsed.expandedNodes, collapsed.collapsedRepoNodes, key);
    expect(reopened.expandedNodes.has(key)).toBe(true);
    expect(reopened.collapsedRepoNodes.has(key)).toBe(false);
  });

  it('preserves a drive root while removing redundant trailing separators', () => {
    expect(normalizeRepoKey('F:\\')).toBe('f:/');
    expect(normalizeRepoKey('F:\\Syncthing\\Repo\\\\')).toBe('f:/Syncthing/Repo');
  });

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

  it('keeps a selected ref and refreshes its short name, or clears it once the ref is gone', () => {
    const kept = reconcileStateWithSnapshot(
      stateWith({ selectedBranchFullName: feature.fullName, selectedBranchRef: 'stale-name' }),
      snapshot,
      new Set(),
    );
    expect(kept.selectedBranchFullName).toBe(feature.fullName);
    expect(kept.selectedBranchRef).toBe('feature');

    const cleared = reconcileStateWithSnapshot(
      stateWith({ selectedBranchFullName: 'refs/heads/deleted', selectedBranchRef: 'deleted' }),
      snapshot,
      new Set(),
    );
    expect(cleared.selectedBranchFullName).toBeNull();
    expect(cleared.selectedBranchRef).toBeNull();
  });

  it('preserves the tab pin across snapshots', () => {
    expect(reconcileStateWithSnapshot(stateWith({ tabPinned: true }), snapshot, new Set()).tabPinned).toBe(true);
  });

  it('reveals the checked-out branch folders on the initial unsaved snapshot', () => {
    const checkedOut = { ...feature, name: 'feature/pdj/current', displayName: 'feature/pdj/current', fullName: 'refs/heads/feature/pdj/current', isCurrent: true };
    const nested: RepoSnapshot = { ...snapshot, localBranches: [checkedOut] };
    const next = reconcileStateWithSnapshot(stateWith({ snapshot: null }), nested, new Set());

    expect(next.expandedNodes).toEqual(
      new Set([
        'branches',
        'repo:/repo',
        remoteNodeKey('origin'),
        'folder:local:feature',
        'folder:local:feature/pdj',
      ]),
    );
  });

  it('preserves restored or manually collapsed checked-out folders on the same branch', () => {
    const checkedOut = { ...feature, name: 'feature/pdj/current', displayName: 'feature/pdj/current', fullName: 'refs/heads/feature/pdj/current', isCurrent: true };
    const nested: RepoSnapshot = { ...snapshot, localBranches: [checkedOut] };
    const restored = stateWith({ snapshot: null, expandedNodes: new Set(['branches']) });
    const initial = reconcileStateWithSnapshot(restored, nested, new Set(['origin']), true);
    const collapsedAgain = reconcileStateWithSnapshot(
      { ...initial, expandedNodes: new Set(['branches']) },
      { ...nested, commits: [...nested.commits] },
      new Set(['origin']),
      true,
    );

    expect(initial.expandedNodes.has('folder:local:feature')).toBe(false);
    expect(collapsedAgain.expandedNodes.has('folder:local:feature')).toBe(false);
  });

  it('reveals ancestor folders when checkout moves to a newly discovered branch', () => {
    const previousCurrent = { ...main, isCurrent: true };
    const nextCurrent = { ...feature, isCurrent: true, name: 'feature/pdj/new', displayName: 'feature/pdj/new', fullName: 'refs/heads/feature/pdj/new' };
    const previousSnapshot: RepoSnapshot = { ...snapshot, localBranches: [previousCurrent, { ...nextCurrent, isCurrent: false }] };
    const nextSnapshot: RepoSnapshot = { ...snapshot, localBranches: [{ ...previousCurrent, isCurrent: false }, nextCurrent] };
    const previous = stateWith({ snapshot: previousSnapshot, expandedNodes: new Set(['branches']) });

    const next = reconcileStateWithSnapshot(previous, nextSnapshot, new Set(['origin']), true);

    expect(next.expandedNodes).toEqual(
      new Set(['branches', 'repo:/repo', 'folder:local:feature', 'folder:local:feature/pdj']),
    );
  });
});

describe('ref selection (checked-out vs. inspected)', () => {
  const v1 = { name: 'v1.0.0', fullName: 'refs/tags/v1.0.0', targetHash: A };
  const checkedOutMain: BranchInfo = { ...main, isCurrent: true };
  const withHead: RepoSnapshot = {
    ...snapshot,
    localBranches: [checkedOutMain, feature, orphan],
    tags: [v1],
  };
  const stateOn = (patch: Partial<ExplorerUiState>): ExplorerUiState => ({ ...createInitialState(), snapshot: withHead, ...patch });

  it('starts with no selection and the tab unpinned', () => {
    const initial = createInitialState();
    expect(initial.selectedBranchFullName).toBeNull();
    expect(initial.selectedBranchRef).toBeNull();
    expect(initial.tabPinned).toBe(false);
  });

  it('lists local, remote and tag refs with their kinds and tips', () => {
    expect(listRefTargets(withHead).map((t) => [t.kind, t.name, t.tipHash])).toEqual([
      ['local', 'main', M],
      ['local', 'feature', F2],
      ['local', 'orphan', X],
      ['remote', 'origin/main', B],
      ['tag', 'v1.0.0', A],
    ]);
    expect(findRefTarget(withHead, 'refs/tags/v1.0.0')?.branch).toBeNull();
    expect(findRefTarget(withHead, 'refs/heads/main')?.branch?.isCurrent).toBe(true);
    expect(findRefTarget(withHead, 'refs/heads/nope')).toBeNull();
    expect(findRefTarget(withHead, null)).toBeNull();
  });

  it('builds a selection patch whose two fields change together', () => {
    const target = findRefTarget(withHead, feature.fullName);
    expect(selectRefPatch(target)).toEqual({ selectedBranchFullName: feature.fullName, selectedBranchRef: 'feature' });
    expect(selectRefPatch(null)).toEqual({ selectedBranchFullName: null, selectedBranchRef: null });
  });

  it('focuses history on commits reachable from a selected local, remote or tag ref', () => {
    expect(hashes(computeVisibleCommits(withHead, stateOn({ selectedBranchFullName: feature.fullName })))).toEqual([F2, F1, A]);
    expect(hashes(computeVisibleCommits(withHead, stateOn({ selectedBranchFullName: originMain.fullName })))).toEqual([B, A]);
    expect(hashes(computeVisibleCommits(withHead, stateOn({ selectedBranchFullName: v1.fullName })))).toEqual([A]);
  });

  it('inspecting a branch does not require it to be the checked-out one', () => {
    const state = stateOn({ selectedBranchFullName: orphan.fullName });
    expect(hashes(computeVisibleCommits(withHead, state))).toEqual([X]);
    expect(withHead.currentBranch).toBe('main');
  });

  it('unions the selection with isolated (pinned) branches in commit order', () => {
    const state = stateOn({ selectedBranchFullName: feature.fullName, pinnedBranchFullNames: new Set([orphan.fullName]) });
    expect(hashes(computeVisibleCommits(withHead, state))).toEqual([F2, F1, A, X]);
    expect(getFocusedRefs(withHead, state).map((t) => t.name)).toEqual(['feature', 'orphan']);
  });

  it('shows nothing for a selection that no longer exists in the snapshot', () => {
    expect(computeVisibleCommits(withHead, stateOn({ selectedBranchFullName: 'refs/heads/gone' }))).toEqual([]);
  });

  it('still applies the history text filter on top of the selection', () => {
    const state = stateOn({ selectedBranchFullName: feature.fullName, historyFilterText: 'part one' });
    expect(hashes(computeVisibleCommits(withHead, state))).toEqual([F1]);
  });

  it('describes the focus with the selected ref first and without duplicates', () => {
    const state = stateOn({
      selectedBranchFullName: orphan.fullName,
      selectedBranchRef: 'orphan',
      pinnedBranchFullNames: new Set([feature.fullName, orphan.fullName]),
    });
    expect(describeHistoryFocus(withHead, state)).toEqual(['orphan', 'feature']);
    expect(describeHistoryFocus(withHead, stateOn({}))).toEqual([]);
  });

  it('resolves HEAD from the checked-out branch, or the HEAD badge when detached', () => {
    expect(getHeadHash(withHead)).toBe(M);
    const detached: RepoSnapshot = { ...withHead, isDetachedHead: true, localBranches: [main, feature, orphan] };
    expect(getHeadHash(detached)).toBe(M);
    expect(getHeadHash({ ...detached, commits: [] })).toBeNull();
  });

  it('detects commits that are already ancestors of HEAD', () => {
    expect(isAncestorOfHead(withHead, F1)).toBe(true);
    expect(isAncestorOfHead(withHead, M)).toBe(true);
    expect(isAncestorOfHead(withHead, X)).toBe(false);
    const behind: RepoSnapshot = { ...withHead, localBranches: [{ ...main, isCurrent: true, tipHash: B }, feature, orphan] };
    expect(isAncestorOfHead(behind, F2)).toBe(false);
  });

  it('filters tags for the branch-tree filter box', () => {
    const tags = [v1, { name: 'release-2', fullName: 'refs/tags/release-2', targetHash: B }];
    expect(filterTags(tags, '').map((t) => t.name)).toEqual(['v1.0.0', 'release-2']);
    expect(filterTags(tags, 'RELEASE').map((t) => t.name)).toEqual(['release-2']);
    expect(filterTags(tags, 'zzz')).toEqual([]);
  });
});

describe('ref toggle feedback', () => {
  const withTag: RepoSnapshot = { ...snapshot, tags: [{ name: 'v1.0.0', fullName: 'refs/tags/v1.0.0', targetHash: A }] };
  const stateOn = (patch: Partial<ExplorerUiState>, snap: RepoSnapshot | null = withTag): ExplorerUiState => ({
    ...createInitialState(),
    snapshot: snap,
    ...patch,
  });

  it('counts refs per toggle', () => {
    expect(summarizeRefToggles(withTag, stateOn({})).map((s) => [s.kind, s.count, s.enabled])).toEqual([
      ['local', 3, true],
      ['remote', 1, true],
      ['tag', 1, true],
    ]);
    expect(summarizeRefToggles(null, createInitialState()).map((s) => s.count)).toEqual([0, 0, 0]);
  });

  it('reports nothing when every kind is shown and populated', () => {
    expect(describeRefFilterStatus(withTag, stateOn({}))).toBeNull();
    expect(describeRefFilterStatus(null, createInitialState())).toBeNull();
  });

  it('explains which populated kinds are hidden', () => {
    expect(describeRefFilterStatus(withTag, stateOn({ showTagBadges: false }))).toBe('Hiding tags (1)');
    expect(describeRefFilterStatus(withTag, stateOn({ showLocalBranchBadges: false, showRemoteBranchBadges: false }))).toBe(
      'Hiding local branches (3), remote branches (1)',
    );
  });

  it('explains when an enabled kind has nothing to show', () => {
    expect(describeRefFilterStatus(snapshot, stateOn({}, snapshot))).toBe('No tags in this repository');
    expect(describeRefFilterStatus(snapshot, stateOn({ showTagBadges: false }, snapshot))).toBeNull();
  });

  it('combines hidden and empty kinds, and flags the all-hidden case', () => {
    expect(describeRefFilterStatus(snapshot, stateOn({ showLocalBranchBadges: false }, snapshot))).toBe(
      'Hiding local branches (3) \u00b7 No tags in this repository',
    );
    expect(
      describeRefFilterStatus(withTag, stateOn({ showLocalBranchBadges: false, showRemoteBranchBadges: false, showTagBadges: false })),
    ).toBe('All ref labels are hidden');
  });

  it('reports how many commits are shown only while history is narrowed', () => {
    expect(describeCommitCount(snapshot, snapshot.commits.length)).toBeNull();
    expect(describeCommitCount(snapshot, 0)).toBe('Showing 0 of 6 commits');
    expect(describeCommitCount(snapshot, 3)).toBe('Showing 3 of 6 commits');
    expect(describeCommitCount(null, 0)).toBeNull();
  });

  it('explains an empty history table', () => {
    expect(describeEmptyHistory({ ...snapshot, commits: [] }, stateOn({}, snapshot))).toBe('No commits yet.');
    expect(describeEmptyHistory(snapshot, stateOn({ historyFilterText: 'zzz' }, snapshot))).toBe('No commits match the current filters.');

    const outsideWindow: RepoSnapshot = {
      ...snapshot,
      tags: [{ name: 'ancient', fullName: 'refs/tags/ancient', targetHash: sha('9') }],
    };
    expect(describeEmptyHistory(outsideWindow, stateOn({ selectedBranchFullName: 'refs/tags/ancient' }, outsideWindow))).toBe(
      'ancient points to a commit outside the loaded history window.',
    );
  });
});

describe('selection sync between the sidebar tree and the editor timeline', () => {
  const tagged: RepoSnapshot = { ...snapshot, tags: [{ name: 'v1.0.0', fullName: 'refs/tags/v1.0.0', targetHash: A }] };

  it('round-trips the selection through the message payload', () => {
    const local = stateWith({
      ...selectRefPatch(listRefTargets(snapshot).find((t) => t.name === 'origin/main') ?? null),
      pinnedBranchFullNames: new Set([feature.fullName, main.fullName]),
    });
    const payload = selectionFromState(local);
    expect(payload).toEqual({
      selectedBranchFullName: originMain.fullName,
      selectedBranchRef: 'origin/main',
      pinnedBranchFullNames: [feature.fullName, main.fullName],
    });

    const remote = { ...createInitialState(), ...selectionPatch(payload) };
    expect(remote.selectedBranchFullName).toBe(originMain.fullName);
    expect(remote.selectedBranchRef).toBe('origin/main');
    expect([...remote.pinnedBranchFullNames]).toEqual([feature.fullName, main.fullName]);
  });

  it('keeps a valid selection and re-derives the short ref name from the snapshot', () => {
    const next = normalizeSelection(tagged, {
      selectedBranchFullName: 'refs/tags/v1.0.0',
      selectedBranchRef: 'forged-name',
      pinnedBranchFullNames: [feature.fullName],
    });
    expect(next).toEqual({ selectedBranchFullName: 'refs/tags/v1.0.0', selectedBranchRef: 'v1.0.0', pinnedBranchFullNames: [feature.fullName] });
  });

  it('drops unknown selections, unknown pins, tag pins and duplicate pins', () => {
    const next = normalizeSelection(tagged, {
      selectedBranchFullName: 'refs/heads/deleted',
      selectedBranchRef: 'deleted',
      pinnedBranchFullNames: [feature.fullName, feature.fullName, 'refs/heads/deleted', 'refs/tags/v1.0.0'],
    });
    expect(next).toEqual({ selectedBranchFullName: null, selectedBranchRef: null, pinnedBranchFullNames: [feature.fullName] });
  });

  it('returns the selection unchanged while no snapshot is loaded', () => {
    const selection = { selectedBranchFullName: main.fullName, selectedBranchRef: 'main', pinnedBranchFullNames: [] };
    expect(normalizeSelection(null, selection)).toBe(selection);
  });

  it('normalizing matches what reconcileStateWithSnapshot does locally, so snapshots need no extra sync message', () => {
    const selection = {
      selectedBranchFullName: 'refs/heads/gone',
      selectedBranchRef: 'gone',
      pinnedBranchFullNames: [feature.fullName, 'refs/heads/gone'],
    };
    const reconciled = reconcileStateWithSnapshot({ ...createInitialState(), ...selectionPatch(selection) }, snapshot, new Set());
    expect(selectionFromState(reconciled)).toEqual(normalizeSelection(snapshot, selection));
  });

  it('compares selections including pin order', () => {
    const a = { selectedBranchFullName: null, selectedBranchRef: null, pinnedBranchFullNames: ['x', 'y'] };
    expect(isSameSelection(a, { ...a, pinnedBranchFullNames: ['x', 'y'] })).toBe(true);
    expect(isSameSelection(a, { ...a, pinnedBranchFullNames: ['y', 'x'] })).toBe(false);
    expect(isSameSelection(a, { ...a, selectedBranchFullName: 'x', selectedBranchRef: 'x' })).toBe(false);
  });
});
